import type { SourceDiffPresentation } from "#shared/source-diff-presentation.js";

export interface ApprovalPresentation {
  readonly prompt: string;
  readonly sourceDiff?: SourceDiffPresentation;
}

const APPROVAL_PRESENTATIONS = Symbol.for("eve.approval-presentations");

interface ApprovalPresentationGlobal {
  [APPROVAL_PRESENTATIONS]?: Map<string, ApprovalPresentation>;
}

/** Attaches trusted host-generated copy to a pending tool approval request. */
export function setApprovalPresentation(
  scope: string,
  callId: string,
  presentation: ApprovalPresentation,
): void {
  registry().set(key(scope, callId), presentation);
}

/** Consumes trusted copy after the corresponding input request has been constructed. */
export function consumeApprovalPresentation(
  scope: string,
  callId: string,
): ApprovalPresentation | undefined {
  const presentationKey = key(scope, callId);
  const presentations = registry();
  const presentation = presentations.get(presentationKey);
  presentations.delete(presentationKey);
  return presentation;
}

function registry(): Map<string, ApprovalPresentation> {
  const global = globalThis as ApprovalPresentationGlobal;
  global[APPROVAL_PRESENTATIONS] ??= new Map();
  return global[APPROVAL_PRESENTATIONS];
}

function key(scope: string, callId: string): string {
  return `${scope}\0${callId}`;
}
