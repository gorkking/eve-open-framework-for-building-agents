import { describe, expect, it } from "vitest";

import { projectActionProgressEvents } from "#execution/progress-action-events.js";

const lineage = {
  id: "work:root:turn",
  kind: "root-turn" as const,
  rootSessionId: "root",
  rootTurnId: "turn",
};

describe("projectActionProgressEvents", () => {
  it("projects tools and skills without inputs", () => {
    expect(
      projectActionProgressEvents({
        at: "2026-01-01T00:00:00Z",
        event: {
          data: {
            actions: [
              {
                callId: "tool-1",
                input: { secret: "hidden" },
                kind: "tool-call",
                toolName: "search",
              },
              { callId: "skill-1", input: { skill: "private" }, kind: "load-skill" },
            ],
            sequence: 0,
            stepIndex: 0,
            turnId: "turn",
          },
          type: "actions.requested",
        },
        lineage,
      }),
    ).toEqual([
      expect.objectContaining({
        action: expect.objectContaining({
          id: "action:work:root:turn:tool-1",
          kind: "tool",
          name: "search",
          stepIndex: 0,
        }),
        kind: "action.started",
      }),
      expect.objectContaining({
        action: expect.objectContaining({
          id: "action:work:root:turn:skill-1",
          kind: "skill",
          name: "load_skill",
          stepIndex: 0,
        }),
        kind: "action.started",
      }),
    ]);
  });

  it("skips delegated actions and projects safe settlement only", () => {
    expect(
      projectActionProgressEvents({
        at: "2026-01-01T00:00:01Z",
        event: {
          data: {
            error: { code: "FAILED", message: "private detail" },
            result: {
              callId: "tool-1",
              isError: true,
              kind: "tool-result",
              output: { secret: "hidden" },
              toolName: "search",
            },
            sequence: 0,
            status: "failed",
            stepIndex: 0,
            turnId: "turn",
          },
          type: "action.result",
        },
        lineage,
      }),
    ).toEqual([
      {
        actionId: "action:work:root:turn:tool-1",
        eventId: "action:work:root:turn:tool-1:settled:failed",
        kind: "action.settled",
        outcome: "failed",
        settledAt: "2026-01-01T00:00:01Z",
      },
    ]);
  });
});
