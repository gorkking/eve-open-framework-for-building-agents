import type { WorkAction, WorkGraph, WorkPhase } from "#harness/work-graph.js";

const ACTIVITY_MESSAGE_MAX_ITEMS = 8;

export interface SlackWorkActivityState {
  workActivityMessageTs?: string | null;
  workActivityTurnId?: string | null;
}

export interface SlackWorkActivityChannel {
  readonly slack: {
    readonly channelId: string;
    request(
      operation: "chat.update",
      body: { readonly channel: string; readonly text: string; readonly ts: string },
    ): Promise<{ readonly error?: string; readonly ok: boolean }>;
  };
  readonly state: SlackWorkActivityState;
  readonly thread: {
    post(message: string): Promise<{ readonly id: string }>;
  };
}

/** Best-effort Slack activity message for the current work graph. */
export async function settleSlackWorkActivity(channel: SlackWorkActivityChannel): Promise<void> {
  const ts = channel.state.workActivityMessageTs;
  if (!ts) return;
  try {
    await channel.slack.request("chat.update", {
      channel: channel.slack.channelId,
      text: "*Work complete*",
      ts,
    });
  } catch {
    // Activity rendering is cosmetic.
  }
}

export async function renderSlackWorkActivity(input: {
  readonly channel: SlackWorkActivityChannel;
  readonly work: WorkGraph | undefined;
}): Promise<void> {
  const turn = input.work?.turn;
  if (turn === undefined) return;
  const text = renderWorkActivity({
    actions: turn.steps.flatMap((step) => step.actions),
    blockers: turn.blockers,
  });
  if (text === undefined) return;

  const currentTs =
    input.channel.state.workActivityTurnId === turn.id
      ? input.channel.state.workActivityMessageTs
      : undefined;
  if (currentTs) {
    try {
      const response = await input.channel.slack.request("chat.update", {
        channel: input.channel.slack.channelId,
        text,
        ts: currentTs,
      });
      if (response.ok === true) return;
      if (response.error !== "message_not_found") return;
    } catch {
      return;
    }
  }

  try {
    const posted = await input.channel.thread.post(text);
    if (posted.id) {
      input.channel.state.workActivityMessageTs = posted.id;
      input.channel.state.workActivityTurnId = turn.id;
    }
  } catch {
    // Activity rendering is cosmetic.
  }
}

function renderWorkActivity(input: {
  readonly actions: readonly WorkAction[];
  readonly blockers: readonly { kind: string; label?: string; phase: string }[];
}): string | undefined {
  const blockers = input.blockers
    .filter((blocker) => blocker.phase === "blocked")
    .map((blocker) => `! ${blocker.label ?? `Waiting for ${blocker.kind}`}`);
  const actions = input.actions
    .filter((action) => action.phase !== "queued")
    .slice(-ACTIVITY_MESSAGE_MAX_ITEMS - blockers.length)
    .map(renderAction);
  const items = [...blockers, ...actions];
  return items.length === 0 ? undefined : ["*Working*", "", ...items].join("\n");
}

function renderAction(action: WorkAction): string {
  const child = action.child?.work?.turn;
  const detail =
    child === undefined ? undefined : summarizeChild(child.steps.flatMap((step) => step.actions));
  return `${phaseGlyph(action.phase)} ${action.name}${detail ? ` — ${detail}` : ""}`;
}

function summarizeChild(actions: readonly WorkAction[]): string | undefined {
  const active = actions.find((action) => action.phase === "running");
  return active?.name;
}

function phaseGlyph(phase: WorkPhase): string {
  switch (phase) {
    case "blocked":
      return "!";
    case "cancelled":
      return "–";
    case "completed":
      return "✓";
    case "failed":
      return "✕";
    case "queued":
      return "○";
    case "running":
      return "◐";
  }
}
