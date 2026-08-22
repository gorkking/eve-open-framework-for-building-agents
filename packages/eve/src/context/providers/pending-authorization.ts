import type { FrameworkContextProvider } from "#context/provider.js";
import {
  getPendingAuthorization,
  PendingAuthorizationStateKey,
  type PendingAuthorizationState,
} from "#harness/authorization.js";

/** Rebuilds active authorization state from the durable session for each step. */
export const pendingAuthorizationProvider: FrameworkContextProvider<PendingAuthorizationState> = {
  key: PendingAuthorizationStateKey,
  create(_ctx, session) {
    const pending = getPendingAuthorization(session.state);
    return pending === undefined ? undefined : { value: pending };
  },
};
