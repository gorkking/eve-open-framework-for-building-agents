import { describe, expect, it, vi } from "vitest";

describe("approval presentation registry", () => {
  it("survives duplicate bundled module instances", async () => {
    const first = await import("./approval-presentation.js");
    first.setApprovalPresentation("session", "call", {
      prompt: "Review changes",
      sourceDiff: { changedBytes: 0, files: [], kind: "source-diff" },
    });

    vi.resetModules();
    const second = await import("./approval-presentation.js");

    expect(second.consumeApprovalPresentation("session", "call")).toMatchObject({
      prompt: "Review changes",
      sourceDiff: { kind: "source-diff" },
    });
  });
});
