import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey, type Session } from "#context/keys.js";
import { reportProgress } from "#execution/report-progress.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import { resumeHook } from "#internal/workflow/runtime.js";

vi.mock("#compiled/@workflow/core/runtime.js", () => ({ resumeHook: vi.fn() }));

function runWithSession(session: Session, callback: () => Promise<unknown>) {
  const context = new ContextContainer();
  context.set(SessionKey, session);
  return contextStorage.run(context, callback);
}

describe("reportProgress", () => {
  it("queues a root report on the root stable command inbox", async () => {
    await runWithSession(
      {
        auth: { current: null, initiator: null },
        sessionId: "root",
        turn: { id: "turn_1", sequence: 1 },
      },
      () => reportProgress({ callId: "call_1", message: "  Running tests\n" }),
    );

    expect(resumeHook).toHaveBeenCalledWith(
      sessionCommandHookToken("root"),
      expect.objectContaining({
        kind: "progress",
        events: [
          expect.objectContaining({
            entityId: "agent:root",
            report: expect.objectContaining({ message: "Running tests" }),
          }),
        ],
      }),
    );
  });

  it("uses framework lineage to route a nested local child to the root", async () => {
    await runWithSession(
      {
        auth: { current: null, initiator: null },
        parent: {
          callId: "child_call",
          rootSessionId: "root",
          sessionId: "parent",
          turn: { id: "parent_turn", sequence: 1 },
        },
        sessionId: "child",
        turn: { id: "turn_2", sequence: 2 },
      },
      () => reportProgress({ callId: "call_2", message: "Checking fixtures" }),
    );

    expect(resumeHook).toHaveBeenLastCalledWith(
      sessionCommandHookToken("root"),
      expect.objectContaining({
        events: [expect.objectContaining({ entityId: "agent:child" })],
      }),
    );
  });

  it("rejects an empty report before queueing", async () => {
    await expect(
      runWithSession(
        {
          auth: { current: null, initiator: null },
          sessionId: "root",
          turn: { id: "turn", sequence: 0 },
        },
        () => reportProgress({ callId: "call", message: " \n " }),
      ),
    ).rejects.toThrow("Provide a non-empty `message`.");
  });
});
