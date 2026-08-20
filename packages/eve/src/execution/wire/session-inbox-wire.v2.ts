import { z } from "#compiled/zod/index.js";

import type {
  DeliverHookPayload,
  SessionCommand,
  SessionTimeoutHookPayload,
} from "#channel/types.js";
import { progressCommandV1Schema } from "#execution/session-progress.js";
import type { VersionMigration } from "#execution/durable-session-migrations/chain.js";
import { SessionInboxWireError } from "#execution/wire/session-inbox-contract.js";
import {
  encodeSessionCommandV1,
  sessionInboxWireV1Schema,
} from "#execution/wire/session-inbox-wire.v1.js";
import { formatValidationError } from "#runtime/validation.js";

const VERSION = 2;
const version = z.literal(VERSION);
const v1 = sessionInboxWireV1Schema.options;

/** Version 2 adds the framework-internal progress command. */
export const sessionInboxWireV2Schema = z.discriminatedUnion("kind", [
  v1[0].extend({ version }),
  v1[1].extend({ version }),
  v1[2].extend({ version }),
  v1[3].extend({ version }),
  v1[4].extend({ version }),
  v1[5].extend({ version }),
  progressCommandV1Schema.extend({ version }),
]);

export type SessionInboxWireV2 = z.infer<typeof sessionInboxWireV2Schema>;

export const sessionInboxWireV1Migration: VersionMigration = {
  from: 1,
  to: 2,
  migrate(value) {
    if (value === null || typeof value !== "object") {
      throw new TypeError("Expected session inbox wire version 1 to be an object.");
    }
    return { ...value, version: VERSION };
  },
};

export function encodeSessionCommandV2(
  command: DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload,
): SessionInboxWireV2 {
  const wire =
    command.kind === "progress"
      ? { ...command, version: VERSION }
      : { ...encodeSessionCommandV1(command), version: VERSION };
  const parsed = sessionInboxWireV2Schema.safeParse(wire);
  if (!parsed.success) {
    throw new SessionInboxWireError(
      `Produced a session inbox payload that does not match wire version ${VERSION}: ${formatValidationError(parsed.error)}`,
    );
  }
  return parsed.data;
}
