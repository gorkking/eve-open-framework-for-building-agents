import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import {
  projectMemoryMessages,
  setActiveMemoryTurn,
  setPendingMemoryCompaction,
  type DurableMemorySlotLock,
  type DurableMemoryTurnState,
} from "#harness/memory-state.js";
import type { HarnessSession } from "#harness/types.js";
import { attributeMemoryMessage } from "#shared/memory-message.js";

describe("memory state", () => {
  it("filters recalled messages by slot and scope without rewriting durable history", () => {
    const userA = slot("user", "scope-a", "scope");
    const userB = slot("user", "scope-b", "scope");
    const workspace = slot("workspace", "workspace-1", "session");
    const ordinary = { content: "ordinary", role: "user" } as const;
    const history: ModelMessage[] = [
      recalled("user A", userA),
      recalled("workspace", workspace),
      ordinary,
      recalled("user B", userB),
    ];
    const original = createSession(history);
    const session = setActiveMemoryTurn(original, turn("turn_1", [userB, workspace]));

    expect(projectMemoryMessages({ messages: history, session })).toEqual([
      history[1],
      ordinary,
      history[3],
    ]);
    expect(session.history).toEqual(history);
    expect(original.history).toEqual(history);
  });

  it("keeps every recalled message for a session-visible slot", () => {
    const userA = slot("user", "scope-a", "scope");
    const userB = slot("user", "scope-b", "session");
    const history = [recalled("user A", userA), recalled("user B", userB)];
    const session = setActiveMemoryTurn(createSession(history), turn("turn_1", [userB]));

    expect(projectMemoryMessages({ messages: history, session })).toEqual(history);
  });

  it("hides recalled messages for disabled and unavailable slots", () => {
    const user = slot("user", "scope-a", "scope");
    const history = [
      recalled("disabled", user),
      recalled("removed slot", slot("removed", "scope-a", "session")),
      { content: "ordinary", role: "user" } as const,
    ];
    const session = setActiveMemoryTurn(
      createSession(history),
      turn("turn_1", [{ scope: null, slot: "user", visibility: "session" }]),
    );

    expect(projectMemoryMessages({ messages: history, session })).toEqual([history[2]]);
  });

  it("uses prepared compaction locks ahead of an active turn", () => {
    const active = slot("user", "scope-a", "scope");
    const compacted = slot("user", "scope-b", "scope");
    const history = [recalled("scope A", active), recalled("scope B", compacted)];
    let session = setActiveMemoryTurn(createSession(history), turn("turn_0", [active]));
    session = setPendingMemoryCompaction(session, {
      modelId: "mock/compact",
      ordinal: 0,
      session: turn("turn_0", [active]).session,
      slots: [compacted],
      standalone: true,
      turn: null,
      usageInputTokens: null,
    });

    expect(projectMemoryMessages({ messages: history, session })).toEqual([history[1]]);
  });

  it("preserves prompt accounting when the visible recalled-message set is unchanged", () => {
    const user = slot("user", "scope-a", "scope");
    const history = [recalled("user A", user)];
    let session = setActiveMemoryTurn(createSession(history), turn("turn_0", [user]));
    session = recordPromptAccounting(session);
    session = setActiveMemoryTurn(session, null);
    session = setActiveMemoryTurn(session, turn("turn_1", [user]));

    expect(session.compaction).toMatchObject({
      lastKnownInputTokens: 25,
      lastKnownPromptMessageCount: 2,
    });
  });

  it("invalidates prompt accounting when a scope change filters earlier recall", () => {
    const userA = slot("user", "scope-a", "scope");
    const userB = slot("user", "scope-b", "scope");
    const history = [recalled("user A", userA), recalled("user B", userB)];
    let session = setActiveMemoryTurn(createSession(history), turn("turn_0", [userA]));
    session = recordPromptAccounting(session);
    session = setActiveMemoryTurn(session, null);
    session = setActiveMemoryTurn(session, turn("turn_1", [userB]));

    expect(session.compaction).toEqual({ recentWindowSize: 8, threshold: 10_000 });
  });
});

function recalled(content: string, lock: DurableMemorySlotLock): ModelMessage {
  if (lock.scope === null) throw new Error("Test recall requires a scope.");
  return attributeMemoryMessage({ content, role: "user" }, { scope: lock.scope, slot: lock.slot });
}

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

function createSession(history: readonly ModelMessage[] = []): HarnessSession {
  return {
    agent: { modelReference: { id: "mock/model" }, system: "", tools: [] },
    compaction: { recentWindowSize: 8, threshold: 10_000 },
    continuationToken: "http:session-1",
    history: [...history],
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
