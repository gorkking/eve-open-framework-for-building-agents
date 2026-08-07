import { describe, expect, it } from "vitest";

import {
  createAttemptId,
  createStepId,
  stepIdFromWorkflowStepId,
} from "#harness/attempt-identity.js";

describe("execution identities", () => {
  it("mints opaque, distinct direct-execution identities", () => {
    expect(createStepId()).toMatch(/^stp_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(createAttemptId()).toMatch(/^atp_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(createAttemptId()).not.toBe(createAttemptId());
  });

  it("derives a stable opaque step identity from Workflow metadata", async () => {
    const first = await stepIdFromWorkflowStepId("workflow-owned-step-123");
    const replay = await stepIdFromWorkflowStepId("workflow-owned-step-123");
    const other = await stepIdFromWorkflowStepId("workflow-owned-step-456");

    expect(first).toBe(replay);
    expect(first).not.toBe(other);
    expect(first).toMatch(/^stp_[0-9a-f]{64}$/);
    expect(first).not.toContain("workflow-owned-step-123");
  });
});
