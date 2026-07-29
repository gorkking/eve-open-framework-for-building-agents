import type { SessionAuthContext } from "#channel/types.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import {
  buildApprovalResponseAuth,
  handleApprovalResponseAuthorizationError,
} from "#execution/tool-auth.js";
import {
  cancelApprovalRequest,
  createApprovalCandidate,
  finishApprovalCandidate,
  getApprovalAuditState,
  markApprovalCandidateAuthorizationRequired,
  settleAllowedCandidate,
} from "#harness/approval-candidates.js";
import {
  getAuthorizationResult,
  isAuthorizationSignal,
  type AuthorizationSignal,
} from "#harness/authorization.js";
import {
  getPendingInputBatch,
  getResponseAuthRequiredRequestIds,
  isApprovalRequest,
} from "#harness/input-requests.js";
import type { HarnessSession, HarnessToolMap, StepInput } from "#harness/types.js";
import type { InputResponse } from "#runtime/input/types.js";

const APPROVAL_AUTHORIZER_TIMEOUT_MS = 10_000;
const APPROVAL_CANDIDATE_TTL_MS = 10 * 60_000;

export type PendingApprovalAuthorizationResult =
  | { readonly kind: "continue"; readonly session: HarnessSession; readonly stepInput?: StepInput }
  | {
      readonly authorization: AuthorizationSignal;
      readonly candidateId: string;
      readonly kind: "authorization-required";
      readonly requestId: string;
      readonly session: HarnessSession;
    }
  | {
      readonly candidateId?: string;
      readonly kind: "rejected" | "duplicate" | "stale" | "failed";
      readonly requestId: string;
      readonly safeReason?: string;
      readonly session: HarnessSession;
      readonly stepInput?: StepInput;
    };

/** Runs response authorization for the first approval response in this delivery. */
export async function authorizePendingApprovalResponse(input: {
  readonly now?: number;
  readonly runtimeRevision?: string;
  readonly session: HarnessSession;
  readonly stepInput?: StepInput;
  readonly tools: HarnessToolMap;
}): Promise<PendingApprovalAuthorizationResult> {
  const batch = getPendingInputBatch(input.session.state);
  const activeCandidate = getApprovalAuditState(input.session.state).activeCandidates.find(
    (candidate) =>
      candidate.status === "authorization-required" &&
      getAuthorizationResult(candidate.candidateId) !== undefined,
  );
  const response =
    input.stepInput?.inputResponses?.find((entry) =>
      batch?.requests.some(
        (request) => request.requestId === entry.requestId && isApprovalRequest(request),
      ),
    ) ??
    (activeCandidate === undefined
      ? undefined
      : { optionId: "approve", requestId: activeCandidate.requestId });
  if (batch === undefined || response === undefined) {
    return { kind: "continue", session: input.session, stepInput: input.stepInput };
  }
  if (response.optionId === "cancel") {
    if (!getResponseAuthRequiredRequestIds(input.session.state).has(response.requestId)) {
      return { kind: "continue", session: input.session, stepInput: input.stepInput };
    }
    const responder = buildCallbackContext().session.auth.current;
    if (responder === null) {
      return rejectWithoutCandidate(
        input,
        response.requestId,
        "An authenticated responder is required.",
      );
    }
    const settled = cancelApprovalRequest({
      actor: responder,
      requestId: response.requestId,
      settledAt: input.now ?? Date.now(),
      state: input.session.state,
    });
    return {
      kind: settled.result.kind === "settled" ? "continue" : "stale",
      requestId: response.requestId,
      session: { ...input.session, state: settled.state },
      stepInput:
        settled.result.kind === "settled"
          ? onlyInputResponse(input.stepInput, response)
          : removeInputResponse(input.stepInput, response.requestId),
    };
  }
  if (response.optionId !== "approve") {
    return { kind: "continue", session: input.session, stepInput: input.stepInput };
  }

  const request = batch.requests.find((entry) => entry.requestId === response.requestId)!;
  if (!getResponseAuthRequiredRequestIds(input.session.state).has(request.requestId)) {
    return { kind: "continue", session: input.session, stepInput: input.stepInput };
  }

  const responder = buildCallbackContext().session.auth.current;
  if (responder === null) {
    return rejectWithoutCandidate(
      input,
      response.requestId,
      "An authenticated responder is required.",
    );
  }
  const now = input.now ?? Date.now();
  const candidateId =
    activeCandidate?.candidateId ?? approvalCandidateId(request.requestId, responder);
  const created = createApprovalCandidate({
    candidateId,
    createdAt: now,
    expiresAt: now + APPROVAL_CANDIDATE_TTL_MS,
    requestId: request.requestId,
    responder,
    runtimeRevision: input.runtimeRevision,
    state: input.session.state,
  });
  let session = { ...input.session, state: created.state };
  if (
    activeCandidate === undefined &&
    (created.result.kind === "duplicate" || created.result.kind === "stale")
  ) {
    return {
      candidateId: created.result.kind === "duplicate" ? candidateId : undefined,
      kind: created.result.kind,
      requestId: response.requestId,
      session,
      stepInput: removeInputResponse(input.stepInput, response.requestId),
    };
  }

  const approval = input.tools.get(request.action.toolName)?.approval;
  const authorizer =
    approval !== undefined && typeof approval !== "function"
      ? approval.authorizeResponse
      : undefined;
  if (authorizer === undefined) {
    return failCandidate({
      candidateId,
      now,
      requestId: response.requestId,
      safeReason: "Approval authorization is temporarily unavailable. Please try again.",
      session,
      stepInput: input.stepInput,
    });
  }

  try {
    const context = buildCallbackContext();
    const outcome = await withAuthorizerTimeout(
      authorizer({
        auth: buildApprovalResponseAuth({ scope: candidateId }),
        request: {
          callId: request.action.callId,
          requestId: request.requestId,
          toolInput: request.action.input,
          toolName: request.action.toolName,
        },
        responder,
        session: {
          id: context.session.id,
          initiator: context.session.auth.initiator,
          parent: context.session.parent,
          turn: context.session.turn,
        },
      }),
    );
    if (outcome !== "allowed") {
      session = {
        ...session,
        state: finishApprovalCandidate({
          candidateId,
          completedAt: now,
          safeReason: outcome.safeReason,
          state: session.state,
          status: "rejected",
        }),
      };
      return {
        candidateId,
        kind: "rejected",
        requestId: response.requestId,
        safeReason: outcome.safeReason,
        session,
        stepInput: removeInputResponse(input.stepInput, response.requestId),
      };
    }
    const settled = settleAllowedCandidate({ candidateId, settledAt: now, state: session.state });
    return {
      kind: settled.result.kind === "settled" ? "continue" : "stale",
      requestId: response.requestId,
      session: { ...session, state: settled.state },
      stepInput:
        settled.result.kind === "settled"
          ? onlyInputResponse(input.stepInput, response)
          : removeInputResponse(input.stepInput, response.requestId),
    };
  } catch (error) {
    const authorization = await handleApprovalResponseAuthorizationError(error).catch(
      () => undefined,
    );
    if (isAuthorizationSignal(authorization)) {
      const providerExpiresAt = authorization.challenges
        .map((entry) => Date.parse(entry.challenge.expiresAt ?? ""))
        .filter(Number.isFinite)
        .sort((a, b) => a - b)[0];
      session = {
        ...session,
        state: markApprovalCandidateAuthorizationRequired({
          candidateId,
          expiresAt: providerExpiresAt,
          provider: authorization.challenges[0]?.challenge.displayName,
          state: session.state,
        }),
      };
      return {
        authorization: {
          ...authorization,
          challenges: authorization.challenges.map((challenge) => ({
            ...challenge,
            candidateId,
          })),
        },
        candidateId,
        kind: "authorization-required",
        requestId: response.requestId,
        session,
      };
    }
    return failCandidate({
      candidateId,
      now,
      requestId: response.requestId,
      safeReason: "We couldn’t verify your approval. Please try again.",
      session,
      stepInput: input.stepInput,
    });
  }
}

function rejectWithoutCandidate(
  input: { readonly session: HarnessSession; readonly stepInput?: StepInput },
  requestId: string,
  safeReason: string,
): PendingApprovalAuthorizationResult {
  return {
    kind: "rejected",
    requestId,
    safeReason,
    session: input.session,
    stepInput: removeInputResponse(input.stepInput, requestId),
  };
}

function failCandidate(input: {
  readonly candidateId: string;
  readonly now: number;
  readonly requestId: string;
  readonly safeReason: string;
  readonly session: HarnessSession;
  readonly stepInput?: StepInput;
}): PendingApprovalAuthorizationResult {
  return {
    candidateId: input.candidateId,
    kind: "failed",
    requestId: input.requestId,
    safeReason: input.safeReason,
    session: {
      ...input.session,
      state: finishApprovalCandidate({
        candidateId: input.candidateId,
        completedAt: input.now,
        state: input.session.state,
        status: "failed",
      }),
    },
    stepInput: removeInputResponse(input.stepInput, input.requestId),
  };
}

function onlyInputResponse(stepInput: StepInput | undefined, response: InputResponse): StepInput {
  return { ...stepInput, inputResponses: [response] };
}

function removeInputResponse(
  stepInput: StepInput | undefined,
  requestId: string,
): StepInput | undefined {
  if (stepInput?.inputResponses === undefined) return stepInput;
  return {
    ...stepInput,
    inputResponses: stepInput.inputResponses.filter((response) => response.requestId !== requestId),
  };
}

function approvalCandidateId(requestId: string, responder: SessionAuthContext): string {
  const principal = [
    responder.authenticator,
    responder.issuer ?? "",
    responder.principalType,
    responder.principalId,
  ].join(":");
  return `${encodeCandidateIdPart(requestId)}.${encodeCandidateIdPart(principal)}`;
}

function encodeCandidateIdPart(value: string): string {
  return Array.from(value, (character) => character.codePointAt(0)!.toString(36)).join("-");
}

async function withAuthorizerTimeout<T>(promise: Promise<T> | T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Approval response authorizer timed out.")),
          APPROVAL_AUTHORIZER_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
