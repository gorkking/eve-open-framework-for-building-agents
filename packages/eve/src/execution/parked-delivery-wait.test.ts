import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DeliverHookPayload } from "#channel/types.js";
import { nextTurnDelivery } from "#execution/parked-delivery-wait.js";
import type { SessionCommandInbox } from "#execution/session-command-inbox.js";
import { filterAwaitedTaskWakePayloadsStep } from "#execution/tasks/wake-suppression-step.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";

vi.mock("./tasks/wake-suppression-step.js", () => ({
  filterAwaitedTaskWakePayloadsStep: vi.fn(),
}));

vi.mock("./route-child-delivery.js", () => ({
  routeDeliverToChildren: vi.fn(),
}));

describe("nextTurnDelivery task wake suppression", () => {
  beforeEach(() => vi.clearAllMocks());
  it("routes only unsuppressed payloads and carries the updated session state", async () => {
    const taskWake = {
      kind: "deliver",
      payloads: [
        {
          message: "task done",
          taskNotification: { status: "completed", taskId: "task_1" },
        },
        { message: "ordinary delivery" },
      ],
    } satisfies DeliverHookPayload;
    const initialState = {
      continuationToken: "token",
      emissionState: { sequence: 0, sessionStarted: false, stepIndex: 0, turnId: "turn" },
      hasProxyInputRequests: false,
      sessionId: "session",
      version: 1,
    } as const;
    const filteredState = { ...initialState, continuationToken: "next-token" };
    vi.mocked(filterAwaitedTaskWakePayloadsStep).mockResolvedValue({
      payloads: [{ message: "ordinary delivery" }],
      sessionState: filteredState,
    });
    vi.mocked(routeDeliverToChildren).mockResolvedValue({
      kind: "continue",
      remainder: { message: "ordinary delivery" },
      serializedContext: {},
      sessionState: filteredState,
    });
    const commandInbox: SessionCommandInbox = {
      claimStable: vi.fn(),
      consumeNext: vi.fn(),
      next: vi.fn(),
      rekeyContinuation: vi.fn(),
    };

    const result = await nextTurnDelivery({
      bufferedDeliveries: [taskWake],
      bufferedSessionControls: [],
      commandInbox,
      driverWritable: new WritableStream<Uint8Array>(),
      serializedContext: {},
      sessionState: initialState,
    });

    expect(result).toMatchObject({
      kind: "turn",
      remainder: { message: "ordinary delivery" },
      sessionState: filteredState,
    });
    expect(routeDeliverToChildren).toHaveBeenCalledWith(
      expect.objectContaining({
        payloads: [{ message: "ordinary delivery" }],
        sessionState: filteredState,
      }),
    );
  });

  it("keeps waiting instead of starting a parent turn for a fully routed task response", async () => {
    const sessionState = {
      continuationToken: "token",
      emissionState: { sequence: 0, sessionStarted: false, stepIndex: 0, turnId: "turn" },
      hasProxyInputRequests: true,
      sessionId: "session",
      version: 1,
    } as const;
    vi.mocked(filterAwaitedTaskWakePayloadsStep).mockImplementation(async ({ payloads }) => ({
      payloads,
      sessionState,
    }));
    vi.mocked(routeDeliverToChildren)
      .mockResolvedValueOnce({
        kind: "continue",
        remainder: undefined,
        serializedContext: {},
        sessionState,
      })
      .mockResolvedValueOnce({
        kind: "continue",
        remainder: { message: "ordinary" },
        serializedContext: {},
        sessionState,
      });
    const commands = [
      { kind: "send" as const, payload: { inputResponses: [{ requestId: "task-request" }] } },
      { kind: "send" as const, payload: { message: "ordinary" } },
    ];
    const commandInbox: SessionCommandInbox = {
      claimStable: vi.fn(),
      consumeNext: vi.fn(),
      next: vi.fn(async () => ({ done: false as const, value: commands.shift()! })),
      rekeyContinuation: vi.fn(),
    };

    const result = await nextTurnDelivery({
      bufferedDeliveries: [],
      bufferedSessionControls: [],
      commandInbox,
      driverWritable: new WritableStream<Uint8Array>(),
      serializedContext: {},
      sessionState,
    });

    expect(result).toMatchObject({ kind: "turn", remainder: { message: "ordinary" } });
    expect(routeDeliverToChildren).toHaveBeenCalledTimes(2);
  });
});
