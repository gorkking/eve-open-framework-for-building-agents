import type { DurableSession } from "#execution/durable-session-store.js";
import { AGENT_HANDLES_STATE_KEY } from "#harness/handles/state-key.js";
import type { AgentHandle, AgentHandleStore } from "#harness/handles/store.js";
import type { HarnessSession } from "#harness/types.js";
import type { SessionTaskIndexEntry } from "#tasks/session-index.js";
import { SESSION_TASKS_STATE_KEY } from "#tasks/session-state-key.js";

interface SubagentToolSessionEffectsInput<TSession extends DurableSession> {
  readonly current: TSession;
  readonly dispatched: DurableSession;
  readonly initial: DurableSession;
  readonly sandboxState?: DurableSession["sandboxState"];
}

/** Applies the task, handle, and sandbox effects returned by one subagent tool dispatch. */
export function reduceSubagentToolExecutionSession(
  input: SubagentToolSessionEffectsInput<HarnessSession>,
): HarnessSession;
export function reduceSubagentToolExecutionSession(
  input: SubagentToolSessionEffectsInput<DurableSession>,
): DurableSession;
export function reduceSubagentToolExecutionSession(
  input: SubagentToolSessionEffectsInput<DurableSession>,
): DurableSession {
  let session = {
    ...input.current,
    sandboxState: input.sandboxState ?? input.current.sandboxState ?? input.dispatched.sandboxState,
  };
  const currentTasks = readSessionTasks(session);
  const currentTaskIds = new Set(currentTasks.map((entry) => entry.taskId));
  const addedTasks = readSessionTasks(input.dispatched).filter(
    (entry) => !currentTaskIds.has(entry.taskId),
  );
  if (addedTasks.length > 0) {
    session = {
      ...session,
      state: {
        ...session.state,
        [SESSION_TASKS_STATE_KEY]: { tasks: [...currentTasks, ...addedTasks] },
      },
    };
  }

  const initialHandles = readAgentHandles(input.initial);
  const initialHandleIds = new Set(initialHandles.map((handle) => handle.identity.id));
  const dispatchedHandles = readAgentHandles(input.dispatched);
  const dispatchedHandleIds = new Set(dispatchedHandles.map((handle) => handle.identity.id));
  const removedHandleIds = new Set(
    initialHandles
      .filter((handle) => !dispatchedHandleIds.has(handle.identity.id))
      .map((handle) => handle.identity.id),
  );
  const handles = readAgentHandles(session).filter(
    (handle) => !removedHandleIds.has(handle.identity.id),
  );
  const knownHandleIds = new Set(handles.map((handle) => handle.identity.id));
  const addedHandles = dispatchedHandles.filter(
    (handle) =>
      !initialHandleIds.has(handle.identity.id) && !knownHandleIds.has(handle.identity.id),
  );
  if (removedHandleIds.size > 0 || addedHandles.length > 0) {
    session = {
      ...session,
      state: {
        ...session.state,
        [AGENT_HANDLES_STATE_KEY]: {
          handles: [...handles, ...addedHandles],
        } satisfies AgentHandleStore,
      },
    };
  }

  return session;
}

function readSessionTasks(session: DurableSession): readonly SessionTaskIndexEntry[] {
  return readStateArray<SessionTaskIndexEntry>(session, SESSION_TASKS_STATE_KEY, "tasks");
}

function readAgentHandles(session: DurableSession): readonly AgentHandle[] {
  return readStateArray<AgentHandle>(session, AGENT_HANDLES_STATE_KEY, "handles");
}

/**
 * Dispatch validates both collections before writing them. This reducer runs
 * in the Workflow driver, so it trusts that persisted invariant instead of
 * importing the zod-backed stores into every generated function.
 */
function readStateArray<T>(
  session: DurableSession,
  stateKey: string,
  collectionKey: string,
): readonly T[] {
  const raw = session.state?.[stateKey];
  if (raw === undefined) return [];
  const collection = (raw as Record<string, unknown>)[collectionKey];
  if (!Array.isArray(collection)) {
    throw new Error(`Corrupt session state collection "${stateKey}".`);
  }
  return collection as readonly T[];
}
