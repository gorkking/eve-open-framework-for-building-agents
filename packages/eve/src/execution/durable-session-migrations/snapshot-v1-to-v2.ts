import type { VersionMigration } from "./chain.js";

const PENDING_INPUT_BATCH_KEY = "eve.runtime.pendingInputBatch";

/** Migrates the singleton pending-input batch into one suffix group. */
export const snapshotV1ToV2: VersionMigration = {
  from: 1,
  to: 2,
  migrate(prior) {
    const snapshot = asRecord(prior);
    const session = asRecord(snapshot?.session);
    const state = asRecord(session?.state);
    const batch = asRecord(state?.[PENDING_INPUT_BATCH_KEY]);
    if (
      snapshot === undefined ||
      session === undefined ||
      state === undefined ||
      batch === undefined ||
      !Array.isArray(batch.requests) ||
      !Array.isArray(batch.responseMessages)
    ) {
      return { ...(snapshot ?? {}), version: 2 };
    }

    return {
      ...snapshot,
      session: {
        ...session,
        state: {
          ...state,
          [PENDING_INPUT_BATCH_KEY]: {
            groups: [
              {
                event: batch.event,
                id: "group_0",
                requests: batch.requests,
                responseMessages: batch.responseMessages,
              },
            ],
            nextGroupSequence: 1,
          },
        },
      },
      version: 2,
    };
  },
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
