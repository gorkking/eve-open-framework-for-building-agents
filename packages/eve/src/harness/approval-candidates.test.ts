import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import {
  cancelApprovalRequest,
  createApprovalCandidate,
  expireApprovalCandidates,
  finishApprovalCandidate,
  getApprovalAuditState,
  markApprovalCandidateAuthorizationRequired,
  settleAllowedCandidate,
} from "#harness/approval-candidates.js";
import type { SessionStateMap } from "#harness/types.js";

function responder(principalId: string): SessionAuthContext {
  return {
    attributes: { workspace: "T1" },
    authenticator: "slack-webhook",
    issuer: "slack:T1",
    principalId,
    principalType: "user",
  };
}

function create(input: {
  readonly candidateId: string;
  readonly principalId: string;
  readonly requestId?: string;
  readonly state?: SessionStateMap;
}) {
  return createApprovalCandidate({
    candidateId: input.candidateId,
    createdAt: 100,
    expiresAt: 700,
    requestId: input.requestId ?? "request-1",
    responder: responder(input.principalId),
    runtimeRevision: "deploy-1",
    state: input.state,
  });
}

describe("approval candidate state", () => {
  it("creates durable candidates without persisting broad responder attributes", () => {
    const transition = create({ candidateId: "candidate-1", principalId: "U1" });

    expect(transition.result).toMatchObject({ kind: "created" });
    expect(getApprovalAuditState(transition.state).activeCandidates).toEqual([
      {
        candidateId: "candidate-1",
        createdAt: 100,
        expiresAt: 700,
        requestId: "request-1",
        responder: {
          authenticator: "slack-webhook",
          issuer: "slack:T1",
          principalId: "U1",
          principalType: "user",
        },
        runtimeRevision: "deploy-1",
        status: "pending",
      },
    ]);
  });

  it("silently deduplicates one responder's active candidate", () => {
    const first = create({ candidateId: "candidate-1", principalId: "U1" });
    const duplicate = create({
      candidateId: "candidate-2",
      principalId: "U1",
      state: first.state,
    });

    expect(duplicate.result).toMatchObject({
      kind: "duplicate",
      candidate: { candidateId: "candidate-1" },
    });
    expect(duplicate.state).toBe(first.state);
  });

  it("allows different responders to validate concurrently", () => {
    const first = create({ candidateId: "candidate-1", principalId: "U1" });
    const second = create({
      candidateId: "candidate-2",
      principalId: "U2",
      state: first.state,
    });

    expect(second.result).toMatchObject({ kind: "created" });
    expect(getApprovalAuditState(second.state).activeCandidates).toHaveLength(2);
  });

  it("tracks authorization-required state and provider expiry", () => {
    const first = create({ candidateId: "candidate-1", principalId: "U1" });
    const state = markApprovalCandidateAuthorizationRequired({
      authorizationName: "candidate-1:github",
      candidateId: "candidate-1",
      expiresAt: 500,
      provider: "GitHub",
      state: first.state,
    });

    expect(getApprovalAuditState(state).activeCandidates[0]).toMatchObject({
      authorizationName: "candidate-1:github",
      expiresAt: 500,
      provider: "GitHub",
      status: "authorization-required",
    });
  });

  it("persists safe rejection feedback and permits a later retry", () => {
    const first = create({ candidateId: "candidate-1", principalId: "U1" });
    const rejected = finishApprovalCandidate({
      candidateId: "candidate-1",
      completedAt: 200,
      safeReason: "GitHub write permission is required.",
      state: first.state,
      status: "rejected",
    });
    const retry = create({
      candidateId: "candidate-2",
      principalId: "U1",
      state: rejected,
    });

    expect(getApprovalAuditState(retry.state).candidateHistory).toEqual([
      expect.objectContaining({
        candidateId: "candidate-1",
        safeReason: "GitHub write permission is required.",
        status: "rejected",
      }),
    ]);
    expect(retry.result).toMatchObject({ kind: "created" });
  });

  it("expires only candidates whose deadline has passed", () => {
    const first = create({ candidateId: "candidate-1", principalId: "U1" });
    const second = createApprovalCandidate({
      candidateId: "candidate-2",
      createdAt: 100,
      expiresAt: 900,
      requestId: "request-1",
      responder: responder("U2"),
      state: first.state,
    });
    const state = expireApprovalCandidates({ now: 800, state: second.state });
    const audit = getApprovalAuditState(state);

    expect(audit.activeCandidates.map((candidate) => candidate.candidateId)).toEqual([
      "candidate-2",
    ]);
    expect(audit.candidateHistory).toEqual([
      expect.objectContaining({ candidateId: "candidate-1", status: "timed-out" }),
    ]);
  });

  it("atomically settles the first allowed candidate and stales competitors", () => {
    const first = create({ candidateId: "candidate-1", principalId: "U1" });
    const second = create({
      candidateId: "candidate-2",
      principalId: "U2",
      state: first.state,
    });
    const winner = settleAllowedCandidate({
      candidateId: "candidate-2",
      settledAt: 300,
      state: second.state,
    });
    const late = settleAllowedCandidate({
      candidateId: "candidate-1",
      settledAt: 400,
      state: winner.state,
    });
    const audit = getApprovalAuditState(late.state);

    expect(winner.result).toMatchObject({
      kind: "settled",
      settlement: { candidateId: "candidate-2", outcome: "allowed" },
    });
    expect(late.result).toMatchObject({ kind: "stale", settlement: { outcome: "allowed" } });
    expect(audit.activeCandidates).toEqual([]);
    expect(audit.candidateHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ candidateId: "candidate-1", status: "stale" }),
        expect.objectContaining({ candidateId: "candidate-2", status: "allowed" }),
      ]),
    );
  });

  it("lets Cancel win atomically and stales every Allow candidate", () => {
    const first = create({ candidateId: "candidate-1", principalId: "U1" });
    const cancelled = cancelApprovalRequest({
      actor: responder("U2"),
      requestId: "request-1",
      settledAt: 250,
      state: first.state,
    });
    const late = settleAllowedCandidate({
      candidateId: "candidate-1",
      settledAt: 300,
      state: cancelled.state,
    });

    expect(cancelled.result).toMatchObject({
      kind: "settled",
      settlement: { actor: { principalId: "U2" }, outcome: "cancelled" },
    });
    expect(late.result).toMatchObject({
      kind: "stale",
      settlement: { outcome: "cancelled" },
    });
  });

  it("does not let a candidate start after terminal settlement", () => {
    const first = create({ candidateId: "candidate-1", principalId: "U1" });
    const settled = settleAllowedCandidate({
      candidateId: "candidate-1",
      settledAt: 300,
      state: first.state,
    });
    const late = create({
      candidateId: "candidate-2",
      principalId: "U2",
      state: settled.state,
    });

    expect(late.result).toMatchObject({ kind: "stale", settlement: { outcome: "allowed" } });
  });

  it("keeps unrelated requests active when another request settles", () => {
    const first = create({ candidateId: "candidate-1", principalId: "U1" });
    const unrelated = create({
      candidateId: "candidate-2",
      principalId: "U2",
      requestId: "request-2",
      state: first.state,
    });
    const settled = settleAllowedCandidate({
      candidateId: "candidate-1",
      settledAt: 300,
      state: unrelated.state,
    });

    expect(getApprovalAuditState(settled.state).activeCandidates).toEqual([
      expect.objectContaining({ candidateId: "candidate-2", requestId: "request-2" }),
    ]);
  });
});
