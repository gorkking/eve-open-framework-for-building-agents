import { z } from "#compiled/zod/index.js";

import {
  MAX_PROGRESS_EVENTS_PER_BATCH,
  type ProgressBatchV1,
  type ProgressEventV1,
  type ProgressWorkIdentityV1,
} from "#execution/session-progress.js";

const boundedString = z.string().min(1).max(500);
const identityString = z.string().min(1).max(1_000);

export const progressWorkIdentityV1Schema: z.ZodType<ProgressWorkIdentityV1> = z
  .object({
    callId: identityString.optional(),
    id: identityString,
    kind: z.enum(["root-turn", "subagent", "remote-agent", "task"]),
    name: boundedString.optional(),
    parentId: identityString.optional(),
    rootSessionId: identityString,
    rootTurnId: identityString,
    sessionId: identityString.optional(),
    turnId: identityString.optional(),
  })
  .strict();

const knownEventSchemas = {
  "action.settled": z
    .object({
      actionId: identityString,
      eventId: identityString,
      kind: z.literal("action.settled"),
      outcome: z.enum(["completed", "failed", "rejected", "cancelled"]),
      settledAt: boundedString,
    })
    .strict(),
  "action.started": z
    .object({
      action: z
        .object({
          id: identityString,
          kind: z.enum(["tool", "skill"]),
          name: boundedString,
          parentWorkId: identityString,
          rootTurnId: identityString,
          stepIndex: z.number().int().nonnegative(),
        })
        .strict(),
      eventId: identityString,
      kind: z.literal("action.started"),
      startedAt: boundedString,
    })
    .strict(),
  "blocker.settled": z
    .object({
      blockerId: identityString,
      eventId: identityString,
      kind: z.literal("blocker.settled"),
      outcome: z.enum(["completed", "cancelled", "failed"]),
      settledAt: boundedString,
    })
    .strict(),
  "blocker.started": z
    .object({
      blocker: z
        .object({
          id: identityString,
          kind: z.enum(["approval", "authorization", "input"]),
          label: boundedString.optional(),
          parentActionId: identityString.optional(),
          parentWorkId: identityString,
          rootTurnId: identityString,
        })
        .strict(),
      eventId: identityString,
      kind: z.literal("blocker.started"),
      startedAt: boundedString,
    })
    .strict(),
  "work.settled": z
    .object({
      eventId: identityString,
      kind: z.literal("work.settled"),
      outcome: z.enum(["completed", "failed", "cancelled"]),
      settledAt: boundedString,
      workId: identityString,
    })
    .strict(),
  "work.started": z
    .object({
      eventId: identityString,
      kind: z.literal("work.started"),
      startedAt: boundedString,
      work: progressWorkIdentityV1Schema,
    })
    .strict(),
} as const;

const batchEnvelopeSchema = z
  .object({
    events: z.array(z.unknown()).max(MAX_PROGRESS_EVENTS_PER_BATCH),
    version: z.literal(1),
  })
  .strict();

/** Parses known lifecycle events while ignoring additive unknown event kinds. */
export function parseProgressBatchV1(value: unknown): ProgressBatchV1 | undefined {
  const envelope = batchEnvelopeSchema.safeParse(value);
  if (!envelope.success) return undefined;
  const events: ProgressEventV1[] = [];
  for (const candidate of envelope.data.events) {
    if (candidate === null || typeof candidate !== "object") return undefined;
    const kind = Reflect.get(candidate, "kind");
    if (typeof kind !== "string" || kind.length === 0) return undefined;
    if (!(kind in knownEventSchemas)) continue;
    const parsed = knownEventSchemas[kind as keyof typeof knownEventSchemas].safeParse(candidate);
    if (!parsed.success) return undefined;
    events.push(parsed.data as ProgressEventV1);
  }
  return { events, version: 1 };
}

export const progressBatchV1Schema: z.ZodType<ProgressBatchV1> = z.custom<ProgressBatchV1>(
  (value) => parseProgressBatchV1(value) !== undefined,
  "Invalid progress batch",
);
