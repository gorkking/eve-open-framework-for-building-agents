import type { SessionAuthContext } from "#channel/types.js";
import type { SessionStateMap } from "#harness/types.js";

const APPROVAL_STATE_KEY = "eve.runtime.hitl.approvalState";

export type ApprovalCandidateStatus =
  | "pending"
  | "authorization-required"
  | "allowed"
  | "rejected"
  | "failed"
  | "timed-out"
  | "stale";

export interface ApprovalCandidateAuditRecord {
  readonly candidateId: string;
  readonly requestId: string;
  readonly responder: ApprovalResponderIdentity;
  readonly status: ApprovalCandidateStatus;
  readonly createdAt: number;
  readonly completedAt?: number;
  readonly expiresAt?: number;
  readonly provider?: string;
  readonly runtimeRevision?: string;
  readonly safeReason?: string;
}

export interface ApprovalResponderIdentity {
  readonly authenticator: string;
  readonly issuer?: string;
  readonly principalId: string;
  readonly principalType: string;
}

export interface ApprovalSettlementAuditRecord {
  readonly actor: ApprovalResponderIdentity;
  readonly outcome: "allowed" | "cancelled";
  readonly requestId: string;
  readonly settledAt: number;
  readonly candidateId?: string;
  readonly eventEmitted?: boolean;
}

interface ActiveApprovalCandidate {
  readonly candidateId: string;
  readonly requestId: string;
  readonly responder: ApprovalResponderIdentity;
  readonly status: "pending" | "authorization-required";
  readonly authorizationName?: string;
  readonly createdAt: number;
  readonly pendingEventEmitted?: boolean;
  readonly expiresAt: number;
  readonly provider?: string;
  readonly runtimeRevision?: string;
}

interface DurableApprovalState {
  readonly activeCandidates: Readonly<Record<string, ActiveApprovalCandidate>>;
  readonly candidateHistory: readonly ApprovalCandidateAuditRecord[];
  readonly settlements: Readonly<Record<string, ApprovalSettlementAuditRecord>>;
}

export type CreateApprovalCandidateResult =
  | { readonly kind: "created"; readonly candidate: ActiveApprovalCandidate }
  | { readonly kind: "duplicate"; readonly candidate: ActiveApprovalCandidate }
  | { readonly kind: "stale"; readonly settlement: ApprovalSettlementAuditRecord };

export type SettleApprovalResult =
  | { readonly kind: "settled"; readonly settlement: ApprovalSettlementAuditRecord }
  | { readonly kind: "stale"; readonly settlement: ApprovalSettlementAuditRecord };

export interface ApprovalStateTransition<TResult> {
  readonly result: TResult;
  readonly state: SessionStateMap | undefined;
}

/** Creates or deduplicates one responder's Allow candidate for a pending request. */
export function createApprovalCandidate(input: {
  readonly candidateId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly requestId: string;
  readonly responder: SessionAuthContext;
  readonly runtimeRevision?: string;
  readonly state: SessionStateMap | undefined;
}): ApprovalStateTransition<CreateApprovalCandidateResult> {
  const approvalState = readApprovalState(input.state);
  const settlement = approvalState.settlements[input.requestId];
  if (settlement !== undefined) {
    return { result: { kind: "stale", settlement }, state: input.state };
  }

  const responder = projectResponder(input.responder);
  const duplicate = Object.values(approvalState.activeCandidates).find(
    (candidate) =>
      candidate.requestId === input.requestId && sameResponder(candidate.responder, responder),
  );
  if (duplicate !== undefined) {
    return { result: { kind: "duplicate", candidate: duplicate }, state: input.state };
  }

  const candidate: ActiveApprovalCandidate = {
    candidateId: input.candidateId,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    requestId: input.requestId,
    responder,
    runtimeRevision: input.runtimeRevision,
    status: "pending",
  };
  const next: DurableApprovalState = {
    ...approvalState,
    activeCandidates: { ...approvalState.activeCandidates, [candidate.candidateId]: candidate },
  };
  return {
    result: { candidate, kind: "created" },
    state: writeApprovalState(input.state, next),
  };
}

/** Marks the pending candidate event as emitted. */
export function markApprovalCandidatePendingEventEmitted(input: {
  readonly candidateId: string;
  readonly state: SessionStateMap | undefined;
}): SessionStateMap | undefined {
  const approvalState = readApprovalState(input.state);
  const candidate = approvalState.activeCandidates[input.candidateId];
  if (candidate === undefined || candidate.pendingEventEmitted === true) return input.state;
  return writeApprovalState(input.state, {
    ...approvalState,
    activeCandidates: {
      ...approvalState.activeCandidates,
      [input.candidateId]: { ...candidate, pendingEventEmitted: true },
    },
  });
}

/** Marks a terminal settlement event as emitted. */
export function markApprovalSettlementEventEmitted(input: {
  readonly requestId: string;
  readonly state: SessionStateMap | undefined;
}): SessionStateMap | undefined {
  const approvalState = readApprovalState(input.state);
  const settlement = approvalState.settlements[input.requestId];
  if (settlement === undefined || settlement.eventEmitted === true) return input.state;
  return writeApprovalState(input.state, {
    ...approvalState,
    settlements: {
      ...approvalState.settlements,
      [input.requestId]: { ...settlement, eventEmitted: true },
    },
  });
}

/** Marks a candidate as waiting on a private authorization challenge. */
export function markApprovalCandidateAuthorizationRequired(input: {
  readonly authorizationName: string;
  readonly candidateId: string;
  readonly expiresAt?: number;
  readonly provider?: string;
  readonly state: SessionStateMap | undefined;
}): SessionStateMap | undefined {
  const approvalState = readApprovalState(input.state);
  const candidate = approvalState.activeCandidates[input.candidateId];
  if (candidate === undefined) return input.state;
  const nextCandidate: ActiveApprovalCandidate = {
    ...candidate,
    authorizationName: input.authorizationName,
    expiresAt: input.expiresAt ?? candidate.expiresAt,
    provider: input.provider,
    status: "authorization-required",
  };
  return writeApprovalState(input.state, {
    ...approvalState,
    activeCandidates: { ...approvalState.activeCandidates, [input.candidateId]: nextCandidate },
  });
}

/** Finishes one candidate without settling the shared request. */
export function finishApprovalCandidate(input: {
  readonly candidateId: string;
  readonly completedAt: number;
  readonly safeReason?: string;
  readonly state: SessionStateMap | undefined;
  readonly status: Exclude<ApprovalCandidateStatus, "pending" | "authorization-required">;
}): SessionStateMap | undefined {
  const approvalState = readApprovalState(input.state);
  const candidate = approvalState.activeCandidates[input.candidateId];
  if (candidate === undefined) return input.state;
  const activeCandidates = { ...approvalState.activeCandidates };
  delete activeCandidates[input.candidateId];
  return writeApprovalState(input.state, {
    ...approvalState,
    activeCandidates,
    candidateHistory: [
      ...approvalState.candidateHistory,
      {
        ...candidate,
        completedAt: input.completedAt,
        safeReason: input.safeReason,
        status: input.status,
      },
    ],
  });
}

/** Expires active candidates whose deterministic deadline has passed. */
export function expireApprovalCandidates(input: {
  readonly now: number;
  readonly state: SessionStateMap | undefined;
}): SessionStateMap | undefined {
  let state = input.state;
  const candidates = Object.values(readApprovalState(state).activeCandidates);
  for (const candidate of candidates) {
    if (candidate.expiresAt > input.now) continue;
    state = finishApprovalCandidate({
      candidateId: candidate.candidateId,
      completedAt: input.now,
      state,
      status: "timed-out",
    });
  }
  return state;
}

/** Atomically settles an allowed candidate; every losing candidate becomes stale. */
export function settleAllowedCandidate(input: {
  readonly candidateId: string;
  readonly settledAt: number;
  readonly state: SessionStateMap | undefined;
}): ApprovalStateTransition<SettleApprovalResult> {
  const approvalState = readApprovalState(input.state);
  const candidate = approvalState.activeCandidates[input.candidateId];
  if (candidate === undefined) {
    const historical = approvalState.candidateHistory.find(
      (entry) => entry.candidateId === input.candidateId,
    );
    const settlement = historical && approvalState.settlements[historical.requestId];
    if (settlement !== undefined) {
      return { result: { kind: "stale", settlement }, state: input.state };
    }
    throw new Error(`Unknown approval candidate "${input.candidateId}".`);
  }
  return settleRequest({
    actor: candidate.responder,
    candidateId: candidate.candidateId,
    outcome: "allowed",
    requestId: candidate.requestId,
    settledAt: input.settledAt,
    state: input.state,
  });
}

/** Atomically cancels a pending request using ordinary authenticated flow control. */
export function cancelApprovalRequest(input: {
  readonly actor: SessionAuthContext;
  readonly requestId: string;
  readonly settledAt: number;
  readonly state: SessionStateMap | undefined;
}): ApprovalStateTransition<SettleApprovalResult> {
  return settleRequest({
    actor: projectResponder(input.actor),
    outcome: "cancelled",
    requestId: input.requestId,
    settledAt: input.settledAt,
    state: input.state,
  });
}

/** Returns one active candidate by id. */
export function getActiveApprovalCandidate(
  state: SessionStateMap | undefined,
  candidateId: string,
): ActiveApprovalCandidate | undefined {
  return readApprovalState(state).activeCandidates[candidateId];
}

/** Returns a copy of the durable candidate/audit state for inspection and replay. */
export function getApprovalAuditState(state: SessionStateMap | undefined): {
  readonly activeCandidates: readonly ActiveApprovalCandidate[];
  readonly candidateHistory: readonly ApprovalCandidateAuditRecord[];
  readonly settlements: readonly ApprovalSettlementAuditRecord[];
} {
  const approvalState = readApprovalState(state);
  return {
    activeCandidates: Object.values(approvalState.activeCandidates),
    candidateHistory: approvalState.candidateHistory,
    settlements: Object.values(approvalState.settlements),
  };
}

function settleRequest(input: {
  readonly actor: ApprovalResponderIdentity;
  readonly candidateId?: string;
  readonly outcome: ApprovalSettlementAuditRecord["outcome"];
  readonly requestId: string;
  readonly settledAt: number;
  readonly state: SessionStateMap | undefined;
}): ApprovalStateTransition<SettleApprovalResult> {
  const approvalState = readApprovalState(input.state);
  const existing = approvalState.settlements[input.requestId];
  if (existing !== undefined) {
    return { result: { kind: "stale", settlement: existing }, state: input.state };
  }

  const settlement: ApprovalSettlementAuditRecord = {
    actor: input.actor,
    candidateId: input.candidateId,
    outcome: input.outcome,
    requestId: input.requestId,
    settledAt: input.settledAt,
  };
  const activeCandidates: Record<string, ActiveApprovalCandidate> = {};
  const candidateHistory = [...approvalState.candidateHistory];
  for (const candidate of Object.values(approvalState.activeCandidates)) {
    if (candidate.requestId !== input.requestId) {
      activeCandidates[candidate.candidateId] = candidate;
      continue;
    }
    candidateHistory.push({
      ...candidate,
      completedAt: input.settledAt,
      status: candidate.candidateId === input.candidateId ? "allowed" : "stale",
    });
  }
  const next: DurableApprovalState = {
    activeCandidates,
    candidateHistory,
    settlements: { ...approvalState.settlements, [input.requestId]: settlement },
  };
  return {
    result: { kind: "settled", settlement },
    state: writeApprovalState(input.state, next),
  };
}

function projectResponder(responder: SessionAuthContext): ApprovalResponderIdentity {
  return {
    authenticator: responder.authenticator,
    issuer: responder.issuer,
    principalId: responder.principalId,
    principalType: responder.principalType,
  };
}

function sameResponder(a: ApprovalResponderIdentity, b: ApprovalResponderIdentity): boolean {
  return (
    a.authenticator === b.authenticator &&
    a.issuer === b.issuer &&
    a.principalId === b.principalId &&
    a.principalType === b.principalType
  );
}

function readApprovalState(state: SessionStateMap | undefined): DurableApprovalState {
  const value = state?.[APPROVAL_STATE_KEY];
  if (typeof value !== "object" || value === null) {
    return { activeCandidates: {}, candidateHistory: [], settlements: {} };
  }
  const candidate = value as Partial<DurableApprovalState>;
  return {
    activeCandidates:
      typeof candidate.activeCandidates === "object" && candidate.activeCandidates !== null
        ? candidate.activeCandidates
        : {},
    candidateHistory: Array.isArray(candidate.candidateHistory) ? candidate.candidateHistory : [],
    settlements:
      typeof candidate.settlements === "object" && candidate.settlements !== null
        ? candidate.settlements
        : {},
  };
}

function writeApprovalState(
  state: SessionStateMap | undefined,
  approvalState: DurableApprovalState,
): SessionStateMap {
  return { ...state, [APPROVAL_STATE_KEY]: approvalState };
}
