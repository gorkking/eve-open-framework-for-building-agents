import { describe, expect, it, vi } from "vitest";

import { renderSlackWorkActivity } from "#public/channels/slack/work-activity.js";

describe("renderSlackWorkActivity", () => {
  it("posts once then updates the same turn activity message", async () => {
    const post = vi.fn(async () => ({ id: "activity-1" }));
    const request = vi.fn(async () => ({ ok: true }));
    const channel = {
      slack: { channelId: "C1", request },
      state: {},
      thread: { post },
    };
    const running = {
      revision: 1,
      turn: {
        blockers: [],
        id: "turn-1",
        phase: "running" as const,
        steps: [
          {
            actions: [
              {
                callId: "call-1",
                kind: "tool-call" as const,
                name: "search_docs",
                phase: "running" as const,
              },
            ],
            phase: "running" as const,
            stepIndex: 0,
          },
        ],
      },
    };

    await renderSlackWorkActivity({ channel, work: running });
    await renderSlackWorkActivity({
      channel,
      work: {
        ...running,
        revision: 2,
        turn: {
          ...running.turn,
          steps: [
            {
              actions: [
                { callId: "call-1", kind: "tool-call", name: "search_docs", phase: "completed" },
              ],
              phase: "completed",
              stepIndex: 0,
            },
          ],
        },
      },
    });

    expect(post).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("chat.update", {
      channel: "C1",
      text: "*Working*\n\n✓ search_docs",
      ts: "activity-1",
    });
  });

  it("reposts when its tracked message is gone", async () => {
    const post = vi.fn(async () => ({ id: "activity-2" }));
    const request = vi.fn(async () => ({ error: "message_not_found", ok: false }));
    const channel = {
      slack: { channelId: "C1", request },
      state: { workActivityMessageTs: "missing", workActivityTurnId: "turn-1" },
      thread: { post },
    };

    await renderSlackWorkActivity({
      channel,
      work: {
        revision: 1,
        turn: {
          blockers: [],
          id: "turn-1",
          phase: "running",
          steps: [
            {
              actions: [
                { callId: "call-1", kind: "tool-call", name: "search_docs", phase: "running" },
              ],
              phase: "running",
              stepIndex: 0,
            },
          ],
        },
      },
    });

    expect(post).toHaveBeenCalledOnce();
    expect(channel.state.workActivityMessageTs).toBe("activity-2");
  });
});
