import { describe, expect, it } from "vitest";

import { translateTaskInboundPayload } from "#tasks/wire.js";

const ZERO_USAGE = { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0 };

describe("translateTaskInboundPayload", () => {
  it("passes explicit task commands through", () => {
    expect(
      translateTaskInboundPayload({ command: { kind: "cancel" }, kind: "task-command" }),
    ).toEqual({ kind: "cancel" });
  });

  it("completes on a succeeded child turn outcome, parked or terminal", () => {
    for (const kind of ["parked", "terminal"] as const) {
      expect(
        translateTaskInboundPayload({
          kind: "runtime-action-result",
          results: [
            {
              outcome: {
                kind,
                result: { kind: "succeeded", output: "answer" },
                usageDelta: ZERO_USAGE,
              },
              output: "answer",
            },
          ],
        }),
      ).toEqual({ data: "answer", kind: "complete" });
    }
  });

  it("fails on a failed outcome and cancels on a cancelled outcome", () => {
    expect(
      translateTaskInboundPayload({
        kind: "runtime-action-result",
        results: [
          {
            outcome: {
              kind: "terminal",
              result: { error: { message: "boom" }, kind: "failed" },
              usageDelta: ZERO_USAGE,
            },
            output: { message: "boom" },
          },
        ],
      }),
    ).toEqual({ data: { message: "boom" }, kind: "fail" });

    expect(
      translateTaskInboundPayload({
        kind: "runtime-action-result",
        results: [
          {
            outcome: { kind: "terminal", result: { kind: "cancelled" }, usageDelta: ZERO_USAGE },
            output: null,
          },
        ],
      }),
    ).toEqual({ kind: "cancel" });
  });

  it("falls back to isError when a result carries no outcome", () => {
    expect(
      translateTaskInboundPayload({
        kind: "runtime-action-result",
        results: [{ isError: true, output: "broken" }],
      }),
    ).toEqual({ data: "broken", kind: "fail" });
    expect(
      translateTaskInboundPayload({ kind: "runtime-action-result", results: [{ output: "ok" }] }),
    ).toEqual({ data: "ok", kind: "complete" });
  });

  it("ignores empty result payloads", () => {
    expect(
      translateTaskInboundPayload({ kind: "runtime-action-result", results: [] }),
    ).toBeUndefined();
  });

  it("marks the task input_required on a forwarded HITL batch", () => {
    expect(
      translateTaskInboundPayload({
        event: { requests: [{ prompt: "Which region?" }] },
        kind: "subagent-input-request",
      }),
    ).toEqual({ inputRequests: [{ prompt: "Which region?" }], kind: "require-input" });
  });

  it("blocks on authorization.required and resumes on authorization.completed", () => {
    expect(
      translateTaskInboundPayload({
        event: { type: "authorization.required" },
        kind: "subagent-authorization-event",
      }),
    ).toEqual({ inputRequests: [{ blockedOn: "authorization" }], kind: "require-input" });
    expect(
      translateTaskInboundPayload({
        event: { type: "authorization.completed" },
        kind: "subagent-authorization-event",
      }),
    ).toEqual({ kind: "resume-working" });
  });
});
