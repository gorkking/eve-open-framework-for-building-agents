import { buildAdapterContext } from "#channel/adapter-context.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { WorkGraphKey } from "#context/keys.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { readLocalSubagentWork } from "#execution/local-subagent-work-query.js";
import { findRunningLocalAgentHandles } from "#harness/handles/query.js";
import { adoptChildWorkSnapshot } from "#harness/work-graph.js";

/** Pulls newer direct local-subagent work snapshots into a parent work graph. */
export async function refreshLocalSubagentWorkStep(input: {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<{ readonly serializedContext: Record<string, unknown> }> {
  "use step";

  const ctx = await deserializeContext(input.serializedContext);
  let work = ctx.get(WorkGraphKey);
  if (work === undefined) return { serializedContext: input.serializedContext };

  const handles = findRunningLocalAgentHandles(input.sessionState.snapshot?.session.state);
  console.info("[eve.work] querying direct local subagents", {
    callIds: handles.map((handle) => handle.operation.callId),
    parentSessionId: input.sessionState.sessionId,
  });
  for (const handle of handles) {
    const child = await readLocalSubagentWork({
      callId: handle.operation.callId,
      parentState: input.sessionState.snapshot?.session.state,
    });
    console.info("[eve.work] local subagent work query", {
      callId: handle.operation.callId,
      childSessionId: handle.address.sessionId,
      outcome: child.kind === "available" ? `available:${child.revision}` : child.reason,
      parentSessionId: input.sessionState.sessionId,
    });
    if (child.kind !== "available") continue;
    const priorRevision = work.revision;
    work = adoptChildWorkSnapshot(work, {
      callId: handle.operation.callId,
      sessionId: handle.address.sessionId,
      snapshot: child.work,
    });
    console.info("[eve.work] local subagent work adoption", {
      callId: handle.operation.callId,
      childRevision: child.revision,
      parentRevision: work.revision,
      parentRevisionBefore: priorRevision,
    });
  }

  if (work === ctx.get(WorkGraphKey)) {
    console.info("[eve.work] parent refresh unchanged", {
      parentSessionId: input.sessionState.sessionId,
    });
    return { serializedContext: input.serializedContext };
  }
  ctx.set(WorkGraphKey, work);
  const adapter = ctx.require(ChannelKey);
  const render = adapter.work?.render;
  if (render !== undefined) {
    await render(buildAdapterContext(adapter, ctx));
    ctx.set(ChannelKey, { ...adapter, state: { ...ctx.require(ChannelKey).state } });
  }
  return { serializedContext: serializeContext(ctx) };
}
