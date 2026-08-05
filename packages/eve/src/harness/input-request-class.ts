/**
 * Shape and behavior classification for pending input requests, shared by
 * the harness resolution path and protocol clients (e.g. the dev TUI's
 * rendering decisions).
 */
import type { InputRequest } from "#runtime/input/types.js";

/** Returns true when the request gates an AI SDK tool call. */
export function isApprovalRequest(request: InputRequest): boolean {
  return request.kind === "tool-approval";
}

/**
 * Behavioral class of a pending input request.
 *
 * `"required"` — the request must receive a terminal response before the turn
 * can move on. A follow-up message denies a pending approval, while an
 * unanswered session-limit prompt continues to gate the turn.
 *
 * `"dismissable"` — a plain follow-up message counts as the user moving on.
 * The request resolves as a real `tool-result` with `status: "ignored"` and
 * the model continues with the message in the same step.
 */
export type InputRequestClass = "dismissable" | "required";

/** Classifies one pending request; see {@link InputRequestClass}. */
export function classifyInputRequest(request: InputRequest): InputRequestClass {
  switch (request.kind) {
    // AI SDK requires a tool approval to resolve in isolation. A follow-up
    // message supplies a denial before the conversation continues.
    case "tool-approval":
      return "required";
    // Ignoring a session-limit continuation cannot move forward. The next
    // pre-model gate would park on the same violation again.
    case "session-limit":
      return "required";
    case "question":
      return "dismissable";
    default: {
      const unhandled: never = request.kind;
      return unhandled;
    }
  }
}
