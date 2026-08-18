import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import {
  anchorUnanchoredVisibleMemoryProjections,
  clearMemoryProjectionAnchors,
  getMemoryState,
  projectMemoryMessages,
  reanchorVisibleMemoryProjections,
  setActiveMemoryTurn,
  updateMemoryProjection,
  type DurableMemorySlotLock,
  type DurableMemoryTurnState,
} from "#harness/memory-state.js";
import type { HarnessSession } from "#harness/types.js";

describe("memory state", () => {
  it("rejects an empty projection before it can establish a prompt anchor", () => {
    const user = slot("user", "scope-a", "scope");
    const session = setActiveMemoryTurn(createSession(), turn("turn_0", [user]));

    expect(() =>
      updateMemoryProjection({
        anchorIndex: 0,
        result: { content: "" },
        scope: user.scope!,
        session,
        slot: "user",
      }),
    ).toThrow(/empty projection/u);
    expect(getMemoryState(session).projections).toEqual([]);
  });

  it("reanchors a scope-hidden projection when that scope becomes active again", () => {
    const userA = slot("user", "scope-a", "scope");
    const userB = slot("user", "scope-b", "scope");
    let session = setActiveMemoryTurn(createSession(), turn("turn_0", [userA]));
    session = updateMemoryProjection({
      anchorIndex: 0,
      result: { content: "user A" },
      scope: userA.scope!,
      session,
      slot: "user",
    });

    session = setActiveMemoryTurn(session, turn("turn_1", [userB]));
    session = anchorUnanchoredVisibleMemoryProjections({
      anchorIndex: 1,
      session,
      slots: [userB],
    });
    session = updateMemoryProjection({
      anchorIndex: 1,
      result: { content: "user B" },
      scope: userB.scope!,
      session,
      slot: "user",
    });
    expect(getMemoryState(session).projections).toMatchObject([
      { anchorIndex: null, content: "user A" },
      { anchorIndex: 1, content: "user B" },
    ]);

    session = setActiveMemoryTurn(session, turn("turn_2", [userA]));
    session = anchorUnanchoredVisibleMemoryProjections({
      anchorIndex: 2,
      session,
      slots: [userA],
    });
    expect(getMemoryState(session).projections).toMatchObject([
      { anchorIndex: 2, content: "user A" },
      { anchorIndex: null, content: "user B" },
    ]);
  });

  it("filters projections by scope, retains session-visible anchors, and suppresses null slots", () => {
    const ordinary: ModelMessage[] = [
      { content: "turn A", role: "user" },
      { content: "turn B", role: "user" },
    ];
    const userA = slot("user", "scope-a", "scope");
    const workspace = slot("workspace", "workspace-1", "session");
    let session = setActiveMemoryTurn(createSession(), turn("turn_0", [userA, workspace]));
    session = updateMemoryProjection({
      anchorIndex: 0,
      result: { content: "user A" },
      scope: userA.scope!,
      session,
      slot: "user",
    });
    session = updateMemoryProjection({
      anchorIndex: 0,
      result: { content: "workspace" },
      scope: workspace.scope!,
      session,
      slot: "workspace",
    });

    const userB = slot("user", "scope-b", "scope");
    session = setActiveMemoryTurn(session, turn("turn_1", [userB, workspace]));
    session = updateMemoryProjection({
      anchorIndex: 1,
      result: { content: "user B" },
      scope: userB.scope!,
      session,
      slot: "user",
    });
    expect(projectMemoryMessages({ messages: ordinary, session })).toEqual([
      { content: "workspace", role: "user" },
      ordinary[0],
      { content: "user B", role: "user" },
      ordinary[1],
    ]);

    session = setActiveMemoryTurn(
      session,
      turn("turn_2", [{ ...userB, visibility: "session" }, workspace]),
    );
    expect(projectMemoryMessages({ messages: ordinary, session })).toEqual([
      { content: "user A", role: "user" },
      { content: "workspace", role: "user" },
      ordinary[0],
      { content: "user B", role: "user" },
      ordinary[1],
    ]);

    session = setActiveMemoryTurn(
      session,
      turn("turn_3", [{ scope: null, slot: "user", visibility: "session" }, workspace]),
    );
    expect(projectMemoryMessages({ messages: ordinary, session })).toEqual([
      { content: "workspace", role: "user" },
      ...ordinary,
    ]);
  });

  it("reanchors only visible projections and clears prompt accounting", () => {
    const userA = slot("user", "scope-a", "scope");
    const workspace = slot("workspace", "workspace-1", "session");
    let session = setActiveMemoryTurn(createSession(), turn("turn_0", [userA, workspace]));
    session = updateMemoryProjection({
      anchorIndex: 0,
      result: { content: "user A" },
      scope: userA.scope!,
      session,
      slot: "user",
    });
    session = updateMemoryProjection({
      anchorIndex: 0,
      result: { content: "workspace" },
      scope: workspace.scope!,
      session,
      slot: "workspace",
    });
    const userB = slot("user", "scope-b", "scope");
    session = setActiveMemoryTurn(session, turn("turn_1", [userB, workspace]));
    session = updateMemoryProjection({
      anchorIndex: 1,
      result: { content: "user B" },
      scope: userB.scope!,
      session,
      slot: "user",
    });
    session = recordPromptAccounting(session);

    session = reanchorVisibleMemoryProjections({
      anchorIndex: 2,
      session,
      slots: [userB, workspace],
    });
    expect(getMemoryState(session).projections).toMatchObject([
      { anchorIndex: null, content: "user A" },
      { anchorIndex: 2, content: "workspace" },
      { anchorIndex: 2, content: "user B" },
    ]);
    expect(session.compaction).toEqual({ recentWindowSize: 8, threshold: 10_000 });

    const cleared = clearMemoryProjectionAnchors(session);
    expect(getMemoryState(cleared).projections).toMatchObject([
      { anchorIndex: null, content: "user A" },
      { anchorIndex: null, content: "workspace" },
      { anchorIndex: null, content: "user B" },
    ]);
  });

  it("preserves prompt accounting across turns with the same visible projections", () => {
    const user = slot("user", "scope-a", "scope");
    let session = setActiveMemoryTurn(createSession(), turn("turn_0", [user]));
    session = updateMemoryProjection({
      anchorIndex: 0,
      result: { content: "user A" },
      scope: user.scope!,
      session,
      slot: "user",
    });
    session = recordPromptAccounting(session);

    session = setActiveMemoryTurn(session, null);
    expect(session.compaction).toMatchObject({
      lastKnownInputTokens: 25,
      lastKnownPromptMessageCount: 2,
    });

    session = setActiveMemoryTurn(session, turn("turn_1", [user]));
    expect(session.compaction).toMatchObject({
      lastKnownInputTokens: 25,
      lastKnownPromptMessageCount: 2,
    });
  });

  it("invalidates retained prompt accounting when projection visibility or content changes", () => {
    const userA = slot("user", "scope-a", "scope");
    let session = setActiveMemoryTurn(createSession(), turn("turn_0", [userA]));
    session = updateMemoryProjection({
      anchorIndex: 0,
      result: { content: "user A" },
      scope: userA.scope!,
      session,
      slot: "user",
    });
    session = recordPromptAccounting(session);
    session = setActiveMemoryTurn(session, null);

    const userB = slot("user", "scope-b", "scope");
    session = setActiveMemoryTurn(session, turn("turn_1", [userB]));
    expect(session.compaction).toEqual({ recentWindowSize: 8, threshold: 10_000 });

    session = updateMemoryProjection({
      anchorIndex: 0,
      result: { content: "user B" },
      scope: userB.scope!,
      session,
      slot: "user",
    });
    session = recordPromptAccounting(session);
    session = updateMemoryProjection({
      anchorIndex: 0,
      result: { content: "user B changed" },
      scope: userB.scope!,
      session,
      slot: "user",
    });
    expect(session.compaction).toEqual({ recentWindowSize: 8, threshold: 10_000 });
  });
});

function slot(
  name: string,
  key: string,
  visibility: DurableMemorySlotLock["visibility"],
): DurableMemorySlotLock {
  return { scope: { key, namespace: "test", value: key }, slot: name, visibility };
}

function turn(turnId: string, slots: readonly DurableMemorySlotLock[]): DurableMemoryTurnState {
  const sequence = Number(turnId.split("_")[1]);
  return {
    principalIdentity: "principal",
    session: {
      auth: { current: null, initiator: null },
      id: "session-1",
      turn: { id: turnId, sequence },
    },
    slots,
    toolMetadata: [],
    turn: { input: [], sequence, turnId },
  };
}

function createSession(): HarnessSession {
  return {
    agent: { modelReference: { id: "mock/model" }, system: "", tools: [] },
    compaction: {
      lastKnownInputTokens: 25,
      lastKnownPromptMessageCount: 2,
      recentWindowSize: 8,
      threshold: 10_000,
    },
    continuationToken: "http:session-1",
    history: [],
    sessionId: "session-1",
  };
}

function recordPromptAccounting(session: HarnessSession): HarnessSession {
  return {
    ...session,
    compaction: {
      ...session.compaction,
      lastKnownInputTokens: 25,
      lastKnownPromptMessageCount: 2,
    },
  };
}
