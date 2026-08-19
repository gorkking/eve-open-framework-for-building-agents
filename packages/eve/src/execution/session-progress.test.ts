import { describe, expect, it } from "vitest";

import {
  MAX_PROGRESS_ACTIVITY,
  MAX_PROGRESS_TEXT_LENGTH,
  createProgressSnapshot,
  normalizeProgressText,
  reduceProgressCommand,
  type ProgressCommandV1,
} from "#execution/session-progress.js";

const turn = {
  id: "turn_1",
  phase: "running" as const,
  sequence: 1,
  startedAt: "2026-08-19T12:00:00.000Z",
};

const entity = {
  depth: 1,
  id: "tool_1",
  kind: "tool" as const,
  label: "Run tests",
  name: "test",
  phase: "running" as const,
  turnId: turn.id,
};

function reduce(command: ProgressCommandV1) {
  return reduceProgressCommand(createProgressSnapshot(), command);
}

describe("reduceProgressCommand", () => {
  it("reduces nested lifecycle events into flat entities and bounded activity", () => {
    const snapshot = reduce({
      commandId: "command_1",
      events: [
        { eventId: "turn-start", kind: "turn", turn },
        {
          at: turn.startedAt,
          entity: { ...entity, parentId: "agent_1" },
          eventId: "tool-start",
          kind: "entity",
        },
      ],
      kind: "progress",
      version: 1,
    });

    expect(snapshot).toMatchObject({
      entities: { tool_1: { parentId: "agent_1", turnId: "turn_1" } },
      recentActivity: [
        { entityId: "turn_1", kind: "lifecycle", phase: "running" },
        { entityId: "tool_1", kind: "tool", phase: "running" },
      ],
      revision: 1,
      turns: { turn_1: turn },
    });
  });

  it("deduplicates commands and replayed events", () => {
    const command: ProgressCommandV1 = {
      commandId: "command_1",
      events: [{ at: turn.startedAt, entity, eventId: "tool-start", kind: "entity" }],
      kind: "progress",
      version: 1,
    };
    const initial = createProgressSnapshot();
    const once = reduceProgressCommand(initial, command);

    expect(reduceProgressCommand(once, command)).toBe(once);
    expect(
      reduceProgressCommand(once, { ...command, commandId: "command_2" }).recentActivity,
    ).toHaveLength(1);
  });

  it("does not reopen terminal work or attach late reports", () => {
    const settled = reduce({
      commandId: "command_1",
      events: [
        { at: turn.startedAt, entity, eventId: "tool-start", kind: "entity" },
        {
          at: "2026-08-19T12:01:00.000Z",
          entity: { ...entity, phase: "completed" },
          eventId: "tool-complete",
          kind: "entity",
        },
      ],
      kind: "progress",
      version: 1,
    });
    const next = reduceProgressCommand(settled, {
      commandId: "command_2",
      events: [
        {
          at: "2026-08-19T12:02:00.000Z",
          entity: { ...entity, phase: "running" },
          eventId: "late-running",
          kind: "entity",
        },
        {
          entityId: entity.id,
          eventId: "late-report",
          kind: "report",
          report: { id: "report_1", message: "too late", reportedAt: "2026-08-19T12:02:00.000Z" },
        },
      ],
      kind: "progress",
      version: 1,
    });

    expect(next.entities.tool_1).toMatchObject({ phase: "completed" });
    expect(next.entities.tool_1?.currentReport).toBeUndefined();
    expect(next.recentActivity).toHaveLength(2);
  });

  it("normalizes untrusted reports and retains only the most recent activity", () => {
    const message = `  running\u0000\n${"x".repeat(MAX_PROGRESS_TEXT_LENGTH + 1)} `;
    expect(normalizeProgressText(message)).toHaveLength(MAX_PROGRESS_TEXT_LENGTH);
    expect(normalizeProgressText(message)).not.toMatch(/[\u0000-\u001F\u007F]/);

    const snapshot = reduce({
      commandId: "command_1",
      events: Array.from({ length: MAX_PROGRESS_ACTIVITY + 1 }, (_, index) => ({
        at: turn.startedAt,
        entity: { ...entity, id: `tool_${index}` },
        eventId: `event_${index}`,
        kind: "entity" as const,
      })),
      kind: "progress",
      version: 1,
    });

    expect(snapshot.recentActivity).toHaveLength(MAX_PROGRESS_ACTIVITY);
    expect(snapshot.recentActivity[0]?.id).toBe("event_1");
  });
});
