import type { UserContent } from "ai";
import { RunExpiredError, WorkflowRunNotFoundError } from "#compiled/@workflow/errors/index.js";

import type { SessionAuthContext } from "#channel/types.js";
import type {
  AgentInvocation,
  AgentInvocationAuthorizationRequest,
  AgentInvocationExecution,
  AgentInvocationMutationResult,
  AgentInvocationStatus,
} from "#internal/invocation/agent-invocation-service.js";
import {
  INVOCATION_OWNER_ATTRIBUTE,
  INVOCATION_TOKEN_ATTRIBUTE,
} from "#internal/invocation/metadata.js";
import { getRun, getWorld } from "#internal/workflow/runtime.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import type { Agent } from "#public/definitions/channel.js";
import type { InputRequest, InputResponse } from "#runtime/input/types.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import { parseJsonValue } from "#shared/json.js";

export class WorkflowAgentInvocationExecution implements AgentInvocationExecution {
  readonly #agent: Agent;
  readonly #channelName: string;

  constructor(agent: Agent, channelName: string) {
    this.#agent = agent;
    this.#channelName = channelName;
  }

  async create(input: {
    readonly auth: SessionAuthContext | null;
    readonly message: string | UserContent;
    readonly outputSchema?: JsonObject;
  }): Promise<AgentInvocation> {
    const continuationToken = `invocation:${crypto.randomUUID()}`;
    const handle = await this.#agent.run({
      adapter: { kind: "http" },
      auth: input.auth,
      capabilities: { requestInput: true },
      channelName: this.#channelName,
      continuationToken: `${this.#channelName}:${continuationToken}`,
      externalInvocation: {
        continuationToken,
        ownerKey: invocationOwnerKey(input.auth),
      },
      input: { message: input.message, outputSchema: input.outputSchema },
      mode: "task",
    });

    const run = await this.#readInvocationRun(handle.sessionId, input.auth);
    if (run === undefined) {
      throw new Error("Invocation run was unavailable after durable creation.");
    }
    return workingInvocation(
      handle.sessionId,
      run.createdAt.toISOString(),
      run.expiredAt?.toISOString(),
    );
  }

  async read(input: {
    readonly auth: SessionAuthContext | null;
    readonly invocationId: string;
  }): Promise<AgentInvocation | undefined> {
    const run = await this.#readInvocationRun(input.invocationId, input.auth);
    if (run === undefined) return undefined;

    if (isTerminalRunStatus(run.status)) {
      return await terminalInvocation(run);
    }
    const events = await readRecentPersistedEvents(input.invocationId);
    return projectNonterminal(
      run.runId,
      run.createdAt.toISOString(),
      run.expiredAt?.toISOString(),
      events,
    );
  }

  async update(input: {
    readonly auth: SessionAuthContext | null;
    readonly invocationId: string;
    readonly responses: readonly InputResponse[];
  }): Promise<AgentInvocationMutationResult> {
    const current = await this.read(input);
    if (current === undefined) return { type: "not_found" };
    if (current.status !== "input_required") {
      return conflict("Invocation is not waiting for input.");
    }
    for (const response of input.responses) {
      if (current.inputRequests?.[response.requestId] === undefined) {
        return conflict(`Unknown input request: ${response.requestId}`);
      }
    }

    const run = await this.#readInvocationRun(input.invocationId, input.auth);
    const token = run?.attributes[INVOCATION_TOKEN_ATTRIBUTE];
    if (token === undefined) return { type: "not_found" };
    try {
      await this.#agent.deliver({
        auth: input.auth,
        continuationToken: `${this.#channelName}:${token}`,
        payload: { inputResponses: input.responses },
      });
    } catch (error) {
      if (RunExpiredError.is(error)) return { type: "not_found" };
      throw error;
    }

    return {
      invocation: workingInvocation(input.invocationId, current.createdAt, current.expiresAt),
      type: "success",
    };
  }

  async cancel(input: {
    readonly auth: SessionAuthContext | null;
    readonly invocationId: string;
  }): Promise<AgentInvocation | undefined> {
    const current = await this.read(input);
    if (current === undefined || isTerminal(current.status)) return current;
    try {
      await getRun(input.invocationId).cancel();
    } catch (error) {
      if (WorkflowRunNotFoundError.is(error) || RunExpiredError.is(error)) return undefined;
      throw error;
    }
    return await this.read(input);
  }

  async #readInvocationRun(invocationId: string, auth: SessionAuthContext | null) {
    const world = await getWorld();
    try {
      const run = await world.runs.get(invocationId);
      if (run.attributes[INVOCATION_TOKEN_ATTRIBUTE] === undefined) return undefined;
      return run.attributes[INVOCATION_OWNER_ATTRIBUTE] === invocationOwnerKey(auth)
        ? run
        : undefined;
    } catch (error) {
      if (WorkflowRunNotFoundError.is(error) || RunExpiredError.is(error)) return undefined;
      throw error;
    }
  }
}

function invocationOwnerKey(auth: SessionAuthContext | null): string {
  if (auth === null) return "anonymous";
  return JSON.stringify([
    auth.authenticator,
    auth.issuer ?? "",
    auth.principalType,
    auth.principalId,
    auth.subject ?? "",
  ]);
}

const INVOCATION_EVENT_WINDOW_SIZE = 64;

async function readRecentPersistedEvents(
  invocationId: string,
): Promise<HandleMessageStreamEvent[]> {
  const readable = getRun(invocationId).getReadable<Uint8Array>({
    startIndex: -INVOCATION_EVENT_WINDOW_SIZE,
  });
  const tailIndex = await readable.getTailIndex();
  if (tailIndex < 0) {
    await readable.cancel("invocation event stream is empty").catch(() => {});
    return [];
  }
  const expectedEvents = Math.min(tailIndex + 1, INVOCATION_EVENT_WINDOW_SIZE);

  const reader = readable.getReader();
  const decoder = new TextDecoder();
  const events: HandleMessageStreamEvent[] = [];
  let buffer = "";
  try {
    while (events.length < expectedEvents) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) events.push(JSON.parse(line) as HandleMessageStreamEvent);
      }
    }
  } finally {
    await reader.cancel("invocation event snapshot complete").catch(() => {});
    reader.releaseLock();
  }
  return events;
}

function projectNonterminal(
  invocationId: string,
  createdAt: string,
  expiresAt: string | undefined,
  events: readonly HandleMessageStreamEvent[],
): AgentInvocation {
  const authorizations = new Map<string, AgentInvocationAuthorizationRequest>();
  let inputRequests: Readonly<Record<string, InputRequest>> | undefined;
  let result: JsonValue | undefined;
  for (const event of events) {
    if (event.type === "input.requested") {
      inputRequests = Object.fromEntries(
        event.data.requests.map((request) => [request.requestId, request]),
      );
    } else if (event.type === "turn.started") {
      authorizations.clear();
      inputRequests = undefined;
      result = undefined;
    } else if (event.type === "authorization.required") {
      const authorization: {
        authorization?: AgentInvocationAuthorizationRequest["authorization"];
        description: string;
        name: string;
        webhookUrl?: string;
      } = {
        description: event.data.description,
        name: event.data.name,
      };
      if (event.data.authorization !== undefined) {
        authorization.authorization = event.data.authorization;
      }
      if (event.data.webhookUrl !== undefined) {
        authorization.webhookUrl = event.data.webhookUrl;
      }
      authorizations.set(event.data.name, authorization);
    } else if (event.type === "authorization.completed") {
      authorizations.delete(event.data.name);
    } else if (event.type === "message.completed" && event.data.message !== null) {
      result = safeJson(event.data.message);
    }
  }
  const pendingAuthorizations = [...authorizations.values()];
  const status: "working" | "input_required" | "authorization_required" =
    pendingAuthorizations.length > 0
      ? "authorization_required"
      : inputRequests === undefined
        ? "working"
        : "input_required";
  return {
    authorizations: pendingAuthorizations.length > 0 ? pendingAuthorizations : undefined,
    createdAt,
    expiresAt,
    inputRequests,
    invocationId,
    pollAfterMs: status === "working" || status === "authorization_required" ? 1_000 : undefined,
    result,
    status,
  };
}

async function terminalInvocation(run: {
  readonly createdAt: Date;
  readonly error?: unknown;
  readonly expiredAt?: Date;
  readonly runId: string;
  readonly status: string;
}): Promise<AgentInvocation> {
  const base = {
    createdAt: run.createdAt.toISOString(),
    expiresAt: run.expiredAt?.toISOString(),
    invocationId: run.runId,
  };
  if (run.status === "cancelled") return { ...base, status: "cancelled" };
  if (run.status === "failed") {
    return {
      ...base,
      error: { code: -32603, data: safeJson(run.error), message: errorMessage(run.error) },
      status: "failed",
    };
  }
  const returned = await getRun<{ readonly output: unknown }>(run.runId).returnValue;
  return { ...base, result: safeJson(returned.output), status: "completed" };
}

function workingInvocation(
  invocationId: string,
  createdAt: string,
  expiresAt: string | undefined,
): AgentInvocation {
  return { createdAt, expiresAt, invocationId, pollAfterMs: 1_000, status: "working" };
}

function safeJson(value: unknown): JsonValue {
  try {
    return parseJsonValue(value);
  } catch {
    return String(value);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Session failed.";
}

function conflict(message: string): AgentInvocationMutationResult {
  return { message, type: "conflict" };
}

function isTerminal(status: AgentInvocationStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isTerminalRunStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
