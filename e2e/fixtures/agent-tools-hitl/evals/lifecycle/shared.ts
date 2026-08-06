import type { EveEvalContext } from "eve/evals";

export const GUARDED_ECHO_TOKEN = "guarded-echo-ok-T4Q9";

/**
 * The HITL lifecycle contract (research/hitl-request-lifecycle.md) is written
 * backwards: these evals encode the normative scenarios before the behavior
 * and lifecycle-event stages land. Until then they skip; flipping this flag
 * activates them as the acceptance suite for those stages.
 */
export const LIFECYCLE_CONTRACT_ACTIVE = process.env.EVE_HITL_LIFECYCLE_CONTRACT === "1";

/** Skips the eval until the lifecycle contract stages are implemented. */
export function gateLifecycle(t: EveEvalContext): void {
  if (!LIFECYCLE_CONTRACT_ACTIVE) {
    t.skip(
      "HITL lifecycle contract not active yet; set EVE_HITL_LIFECYCLE_CONTRACT=1 " +
        "once the behavior and lifecycle-event stages land " +
        "(research/hitl-request-lifecycle.md).",
    );
  }
}

/**
 * Index of the first event with `type`, optionally constrained by a data
 * predicate. Typed loosely on purpose: the lifecycle events do not exist in
 * the protocol union yet, and these evals are the executable spec for them.
 */
export function eventIndex(
  events: readonly unknown[],
  type: string,
  match?: (data: Record<string, unknown>) => boolean,
): number {
  return events.findIndex((event) => {
    const candidate = event as { type?: string; data?: Record<string, unknown> };
    if (candidate.type !== type) return false;
    return match === undefined || match(candidate.data ?? {});
  });
}

/** True when `first` occurs and precedes `second` in the event list. */
export function eventBefore(
  events: readonly unknown[],
  first: { type: string; match?: (data: Record<string, unknown>) => boolean },
  second: { type: string; match?: (data: Record<string, unknown>) => boolean },
): boolean {
  const firstIndex = eventIndex(events, first.type, first.match);
  const secondIndex = eventIndex(events, second.type, second.match);
  return firstIndex >= 0 && secondIndex >= 0 && firstIndex < secondIndex;
}

/** True when no event with `type` exists. */
export function noEvent(events: readonly unknown[], type: string): boolean {
  return eventIndex(events, type) === -1;
}
