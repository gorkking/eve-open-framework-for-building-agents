import { buildAdapterContext } from "#channel/adapter-context.js";
import type { ChannelAdapter, ChannelAdapterContext } from "#channel/adapter.js";
import {
  isChannelGateDecision,
  type ChannelGateContext,
  type InputResponseGateInput,
  type SessionChannelGateName,
  type SessionResumeGateInput,
} from "#channel/gates.js";
import { resolveTextToResponses } from "#channel/resolve-text.js";
import type {
  ChannelGateOperation,
  ChannelGateReceipt,
  DeliverHookPayload,
  DeliverPayload,
} from "#channel/types.js";
import {
  AuthKey,
  ChannelGateNamesKey,
  ContinuationTokenKey,
  InitiatorAuthKey,
  ParentSessionKey,
} from "#context/keys.js";
import { deserializeContext } from "#context/serialize.js";
import {
  CHANNEL_GATE_PROTOCOL_VERSION,
  type ChannelGateEvaluation,
  type ChannelGateReady,
  type ChannelGateStepInput,
} from "#execution/channel-gate-protocol.js";
import { readDurableSession } from "#execution/durable-session-store.js";
import { coalesceDeliverPayloads } from "#execution/deliver-payloads.js";
import { getHarnessEmissionState } from "#harness/emission.js";
import { classifyInputRequest } from "#harness/input-request-class.js";
import { getPendingInputRequests } from "#harness/input-requests.js";
import { getProxyInputRequests } from "#harness/proxy-input-requests.js";
import { createLogger, logError } from "#internal/logging.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import type { InputRequest } from "#runtime/input/types.js";

const log = createLogger("channel.gate");

interface LiveGateEnvironment {
  readonly adapter: ChannelAdapter;
  readonly adapterCtx: ChannelAdapterContext;
  readonly gateCtx: ChannelGateContext;
  readonly requests: readonly InputRequest[];
}

/** Publishes immutable protocol metadata before the session accepts gated operations. */
export async function publishChannelGateReadyStep(input: {
  readonly serializedContext: Record<string, unknown>;
  readonly writable: WritableStream<ChannelGateReady>;
}): Promise<void> {
  "use step";

  const ctx = await deserializeContext(input.serializedContext);
  const adapter = ctx.require(ChannelKey);
  const names = readConfiguredGateNames(input.serializedContext);
  const writer = input.writable.getWriter();
  try {
    await writer.write({
      adapterKind: adapter.kind,
      names,
      version: CHANNEL_GATE_PROTOCOL_VERSION,
    });
  } finally {
    writer.releaseLock();
  }
}

/** Acknowledges an allowed operation after the target workflow accepts it. */
export async function publishChannelGateAllowStep(input: {
  readonly id: string;
  readonly writable?: WritableStream<ChannelGateReceipt>;
}): Promise<void> {
  "use step";

  await publishReceipt(input.writable, { id: input.id, status: "allow" });
}

/** Evaluates resume/input-response gates against the session consuming a delivery. */
export async function evaluateChannelDeliveryGatesStep(
  input: ChannelGateStepInput & { readonly delivery: DeliverHookPayload },
): Promise<ChannelGateEvaluation> {
  "use step";

  const environment = await loadEnvironment(input);
  if ("receipt" in environment) {
    await publishReceipt(input.receiptWritable, environment.receipt);
    return { status: "block" };
  }

  const payload = coalesceDeliverPayloads(input.delivery.payloads);
  const resume = await evaluateGate({
    environment,
    input: toSessionResumeGateInput(payload),
    name: "session.resume",
    operation: input.operation,
  });
  if (resume !== undefined) {
    await publishReceipt(input.receiptWritable, resume);
    return { status: "block" };
  }

  const responseInput = resolveInputResponseGateInput(payload, environment.requests);
  if (responseInput !== undefined) {
    const response = await evaluateGate({
      environment,
      input: responseInput,
      name: "input.response",
      operation: input.operation,
    });
    if (response !== undefined) {
      await publishReceipt(input.receiptWritable, response);
      return { status: "block" };
    }
  }

  return { status: "allow" };
}

function toSessionResumeGateInput(payload: DeliverPayload): SessionResumeGateInput {
  const input: {
    -readonly [Key in keyof SessionResumeGateInput]?: SessionResumeGateInput[Key];
  } = {};
  if (payload.context !== undefined) input.context = payload.context;
  if (payload.inputResponses !== undefined) input.inputResponses = payload.inputResponses;
  if (payload.message !== undefined) input.message = payload.message;
  if (payload.outputSchema !== undefined) input.outputSchema = payload.outputSchema;
  return input;
}

/** Evaluates a public cancellation before the active turn aborts. */
export async function evaluateTurnCancelGateStep(
  input: ChannelGateStepInput & {
    readonly available: boolean;
    readonly continuationToken?: string;
    readonly turnId?: string;
  },
): Promise<ChannelGateEvaluation> {
  "use step";

  if (input.continuationToken !== undefined) {
    const durable = await readDurableSession(input.sessionState);
    if (durable.continuationToken !== input.continuationToken) {
      await publishReceipt(input.receiptWritable, {
        id: input.operation.id,
        status: "no_active_session",
      });
      return { status: "block" };
    }
  }

  if (!input.available) {
    await publishReceipt(input.receiptWritable, {
      id: input.operation.id,
      status: "no_active_session",
    });
    return { status: "block" };
  }

  return await evaluateSingleGate(
    input,
    "turn.cancel",
    input.turnId === undefined ? {} : { turnId: input.turnId },
  );
}

/** Evaluates a reset against the session that will terminate itself. */
export async function evaluateSessionResetGateStep(
  input: ChannelGateStepInput & {
    readonly continuationToken: string;
    readonly reason?: string;
  },
): Promise<ChannelGateEvaluation> {
  "use step";

  const durable = await readDurableSession(input.sessionState);
  if (durable.continuationToken !== input.continuationToken) {
    await publishReceipt(input.receiptWritable, {
      id: input.operation.id,
      status: "no_active_session",
    });
    return { status: "block" };
  }

  return await evaluateSingleGate(
    input,
    "session.reset",
    input.reason === undefined ? {} : { reason: input.reason },
  );
}

async function evaluateSingleGate(
  input: ChannelGateStepInput,
  name: SessionChannelGateName,
  gateInput: unknown,
): Promise<ChannelGateEvaluation> {
  const environment = await loadEnvironment(input);
  if ("receipt" in environment) {
    await publishReceipt(input.receiptWritable, environment.receipt);
    return { status: "block" };
  }

  const receipt = await evaluateGate({
    environment,
    input: gateInput,
    name,
    operation: input.operation,
  });
  if (receipt !== undefined) {
    await publishReceipt(input.receiptWritable, receipt);
    return { status: "block" };
  }

  return { status: "allow" };
}

async function loadEnvironment(
  input: ChannelGateStepInput,
): Promise<LiveGateEnvironment | { readonly receipt: ChannelGateReceipt }> {
  let durable;
  let ctx;
  try {
    [durable, ctx] = await Promise.all([
      readDurableSession(input.sessionState),
      deserializeContext(input.serializedContext),
    ]);
  } catch (error) {
    return { receipt: unavailable(firstGate(input.operation), input.operation.id, error) };
  }

  const configuredNames = readConfiguredGateNames(input.serializedContext);
  for (const name of input.operation.names) {
    if (!configuredNames.includes(name)) {
      return {
        receipt: unavailable(
          name,
          input.operation.id,
          new Error(`Session did not declare configured channel gate "${name}".`),
        ),
      };
    }
  }

  const adapter = ctx.get(ChannelKey);
  if (adapter === undefined || adapter.kind !== input.operation.adapterKind) {
    return {
      receipt: unavailable(
        firstGate(input.operation),
        input.operation.id,
        new Error(
          `Session channel adapter "${input.operation.adapterKind}" could not be rehydrated.`,
        ),
      ),
    };
  }
  for (const name of input.operation.names) {
    if (adapter.gates?.[name] === undefined) {
      return {
        receipt: unavailable(
          name,
          input.operation.id,
          new Error(`Configured channel gate "${name}" could not be rehydrated.`),
        ),
      };
    }
  }

  ctx.set(AuthKey, input.operation.auth);
  ctx.set(ContinuationTokenKey, durable.continuationToken);
  const initiator = ctx.get(InitiatorAuthKey) ?? null;
  const emission = getHarnessEmissionState(durable.state);
  const proxyEntries = [...getProxyInputRequests(durable.state).values()];
  if (proxyEntries.some((entry) => entry.request === undefined)) {
    return {
      receipt: unavailable(
        firstGate(input.operation),
        input.operation.id,
        new Error("The session has an incomplete proxied input request."),
      ),
    };
  }

  const requests = new Map<string, InputRequest>();
  for (const request of [
    ...getPendingInputRequests(durable.state),
    ...proxyEntries.flatMap((entry) => (entry.request === undefined ? [] : [entry.request])),
  ]) {
    requests.set(request.requestId, structuredClone(request));
  }

  return {
    adapter,
    adapterCtx: buildAdapterContext(adapter, ctx),
    gateCtx: {
      session: {
        auth: {
          current: input.operation.auth,
          initiator,
        },
        id: durable.sessionId,
        parent: ctx.get(ParentSessionKey),
        turn: {
          id: emission.turnId === "" ? `turn_${emission.sequence}` : emission.turnId,
          sequence: emission.sequence,
        },
      },
    },
    requests: [...requests.values()],
  };
}

async function evaluateGate(input: {
  readonly environment: LiveGateEnvironment;
  readonly input: unknown;
  readonly name: SessionChannelGateName;
  readonly operation: ChannelGateOperation;
}): Promise<ChannelGateReceipt | undefined> {
  if (!input.operation.names.includes(input.name)) return undefined;
  const gate = input.environment.adapter.gates?.[input.name];
  if (gate === undefined) {
    return unavailable(
      input.name,
      input.operation.id,
      new Error(`Configured channel gate "${input.name}" could not be rehydrated.`),
    );
  }

  let decision;
  try {
    decision = await gate(input.input, input.environment.adapterCtx, input.environment.gateCtx);
  } catch (error) {
    return unavailable(input.name, input.operation.id, error);
  }

  if (!isChannelGateDecision(decision)) {
    return unavailable(
      input.name,
      input.operation.id,
      new TypeError(`Channel gate "${input.name}" returned an invalid decision.`),
    );
  }
  return decision.type === "deny"
    ? {
        gate: input.name,
        id: input.operation.id,
        reason: decision.reason,
        status: "denied",
      }
    : undefined;
}

/** Projects one delivery onto the HITL resolution a gate must authorize. */
export function resolveInputResponseGateInput(
  payload: DeliverPayload,
  requests: readonly InputRequest[],
): InputResponseGateInput | undefined {
  const explicit = payload.inputResponses ?? [];
  if (explicit.length > 0) {
    return {
      requests,
      responses: explicit,
      source: "explicit",
      type: "answer",
    };
  }

  if (typeof payload.message !== "string" || requests.length === 0) return undefined;
  const responses = resolveTextToResponses(payload.message, requests);
  if (responses.length > 0) {
    return {
      requests,
      responses,
      source: "text",
      type: "answer",
    };
  }

  if (requests.every((request) => classifyInputRequest(request) === "dismissable")) {
    return {
      requests,
      responses: [],
      source: "message",
      type: "dismiss",
    };
  }

  return undefined;
}

function readConfiguredGateNames(
  serializedContext: Record<string, unknown>,
): readonly SessionChannelGateName[] {
  const names = serializedContext[ChannelGateNamesKey.name];
  if (!Array.isArray(names)) return [];
  return names.filter(
    (name): name is SessionChannelGateName =>
      name === "session.resume" ||
      name === "input.response" ||
      name === "turn.cancel" ||
      name === "session.reset",
  );
}

async function publishReceipt(
  writable: WritableStream<ChannelGateReceipt> | undefined,
  receipt: ChannelGateReceipt,
): Promise<void> {
  if (writable === undefined) {
    throw new Error("Target session cannot acknowledge channel gate evaluation.");
  }
  const writer = writable.getWriter();
  try {
    await writer.write(receipt);
  } finally {
    writer.releaseLock();
  }
}

function unavailable(
  gate: SessionChannelGateName,
  id: string,
  error: unknown,
): Extract<ChannelGateReceipt, { readonly status: "unavailable" }> {
  const errorId = logError(log, "channel gate unavailable", error, { gate });
  return { errorId, gate, id, status: "unavailable" };
}

function firstGate(operation: ChannelGateOperation): SessionChannelGateName {
  return operation.names[0] ?? "session.resume";
}
