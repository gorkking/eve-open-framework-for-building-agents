import {
  abandonInstrumentationState,
  instrumentationStateSlot,
  isInstrumentationStateAbandoned,
  releaseAllInstrumentationAttemptState,
  releaseAllInstrumentationState,
} from "#harness/instrumentation-state.js";
import { createLogger, formatError } from "#internal/logging.js";

import type {
  CreateInstrumentationHooksOptions,
  InstrumentationDispatchGroups,
  InstrumentationEvent,
  InstrumentationEventHandler,
  InstrumentationHooks,
  InstrumentationHooksInput,
  InstrumentationProviderDefinition,
} from "#harness/instrumentation-lifecycle.js";

const log = createLogger("harness.instrumentation-dispatch");
const DEFAULT_HANDLER_TIMEOUT_MS = 5_000;

export function createInstrumentationDispatcher(
  input: InstrumentationHooksInput,
  options: CreateInstrumentationHooksOptions,
): InstrumentationHooks {
  const handlerTimeoutMs = options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
  const groups = normalizeDispatchGroups(input);
  const snapshots = new WeakMap<object, unknown>();

  const publish = async (event: InstrumentationEvent): Promise<void> => {
    const snapshot = snapshotInstrumentationEvent(event, snapshots);
    try {
      try {
        for (const provider of groups.serialBefore) {
          await dispatchToProvider(provider, snapshot, handlerTimeoutMs);
        }

        if (groups.parallel.length === 1) {
          await dispatchToProvider(groups.parallel[0]!, snapshot, handlerTimeoutMs);
        } else if (groups.parallel.length > 1) {
          const results = await Promise.allSettled(
            groups.parallel.map((provider) =>
              dispatchToProvider(provider, snapshot, handlerTimeoutMs),
            ),
          );
          const rejected = results.find(
            (result): result is PromiseRejectedResult => result.status === "rejected",
          );
          if (rejected !== undefined) throw rejected.reason;
        }
      } finally {
        for (const provider of groups.serialAfter) {
          await dispatchToProvider(provider, snapshot, handlerTimeoutMs);
        }
      }
    } finally {
      releaseTerminalState(snapshot);
    }
  };

  return { publish };
}

function snapshotInstrumentationEvent(
  event: InstrumentationEvent,
  snapshots: WeakMap<object, unknown>,
): InstrumentationEvent {
  return snapshotPlainValue(event, snapshots) as InstrumentationEvent;
}

function snapshotPlainValue(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (Array.isArray(value)) {
    const existing = seen.get(value);
    if (existing !== undefined) return existing;
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const entry of value) copy.push(snapshotPlainValue(entry, seen));
    return Object.freeze(copy);
  }

  if (typeof value !== "object" || value === null) return value;
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
  } catch {
    return value;
  }
  if (prototype !== Object.prototype && prototype !== null) return value;

  const existing = seen.get(value);
  if (existing !== undefined) return existing;
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, entry] of Object.entries(value)) {
    copy[key] = snapshotPlainValue(entry, seen);
  }
  return Object.freeze(copy);
}

function normalizeDispatchGroups(
  input: InstrumentationHooksInput,
): Required<InstrumentationDispatchGroups> {
  if (!Array.isArray(input)) {
    const groups = input as InstrumentationDispatchGroups;
    return {
      parallel: groups.parallel ?? [],
      serialAfter: groups.serialAfter ?? [],
      serialBefore: groups.serialBefore ?? [],
    };
  }

  return {
    parallel: [],
    serialAfter: [],
    serialBefore: input.map((provider, index) => ({
      ...provider,
      name: provider.name ?? `provider-${String(index)}`,
    })),
  };
}

async function dispatchToProvider(
  provider: InstrumentationProviderDefinition,
  event: InstrumentationEvent,
  handlerTimeoutMs: number,
): Promise<void> {
  const startedBoundary = event.type.endsWith(".started") || event.type === "input.requested";
  const attemptId = stateAttemptId(event);
  const providerName = provider.name;
  if (isInstrumentationStateAbandoned(providerName, event.idempotencyKey)) return;
  const handler = provider.events?.[event.type];
  if (handler === undefined) return;
  const state = instrumentationStateSlot(providerName, event.idempotencyKey, attemptId);
  try {
    const settled = await withTimeout(
      () => (handler as InstrumentationEventHandler<InstrumentationEvent>)(event, { state }),
      handlerTimeoutMs,
      () => {
        state.revoke();
        if (startedBoundary)
          abandonInstrumentationState(providerName, event.idempotencyKey, attemptId);
      },
    );
    if (!settled) {
      log.warn("instrumentation provider timed out", {
        boundary: event.type,
        provider: providerName,
        timeoutMs: handlerTimeoutMs,
      });
    }
  } catch (error) {
    log.warn("instrumentation provider failed", {
      boundary: event.type,
      error: formatError(error),
      provider: providerName,
    });
  } finally {
    state.revoke();
  }
}

async function withTimeout(
  run: () => void | PromiseLike<void>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(run()).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          onTimeout();
          resolve(false);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function stateAttemptId(event: InstrumentationEvent): string | undefined {
  if (!("scope" in event)) return undefined;
  return event.type.startsWith("model.call.") ||
    event.type.startsWith("tool.call.") ||
    event.type.startsWith("step.attempt.")
    ? event.scope.attemptId
    : undefined;
}

function releaseTerminalState(event: InstrumentationEvent): void {
  if (isTerminal(event.type)) releaseAllInstrumentationState(event.idempotencyKey);
  if (event.type === "step.attempt.completed" || event.type === "step.attempt.failed") {
    releaseAllInstrumentationAttemptState(event.scope.attemptId);
  }
}

function isTerminal(type: InstrumentationEvent["type"]): boolean {
  return (
    type.endsWith(".completed") ||
    type.endsWith(".failed") ||
    type.endsWith(".cancelled") ||
    type === "input.resolved"
  );
}
