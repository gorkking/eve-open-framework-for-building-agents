import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import {
  mockModel,
  type MockModelRequest,
  type MockModelResponse,
  type MockModelToolResult,
} from "eve/evals";

const TASK_ID_PATTERN = /task_[a-z0-9]+/iu;

function respond(request: MockModelRequest): MockModelResponse | string {
  const message = request.lastUserMessage ?? "";
  if (message.startsWith("Background task ")) return "TASK-NOTIFICATION-ACK";

  if (message.startsWith("TASK-HITL-VERIFY ")) {
    return peekTask(request, "task-hitl-verify", "TASK-HITL-STATUS", message);
  }
  if (message.startsWith("TASK-INPUT-BATCH-VERIFY ")) {
    return peekTask(request, "task-input-batch-verify", "TASK-INPUT-BATCH-STATUS", message);
  }
  if (message.startsWith("CHILD-TASK-EXCLUSIVITY-VERIFY ")) {
    return peekTask(
      request,
      "child-task-exclusivity-verify",
      "CHILD-TASK-EXCLUSIVITY-STATUS",
      message,
    );
  }
  if (message === "TASK-HITL-ROUTING") {
    return startApprovalWorker(request, "task-hitl-worker", "TASK-HITL-STARTED");
  }
  if (message === "TASK-INPUT-BATCH-ORDERING") {
    return startApprovalWorker(request, "task-input-batch-worker", "TASK-INPUT-BATCH-STARTED");
  }
  if (message === "CHILD-TASK-EXCLUSIVITY-SETUP") return setupBusyWorker(request);
  if (message === "CHILD-TASK-EXCLUSIVITY-RACE") return raceBusyWorker(request);

  return `Mock reply: ${message}`;
}

function startApprovalWorker(
  request: MockModelRequest,
  callId: string,
  completedText: string,
): MockModelResponse | string {
  if (resultById(request, callId) === undefined) {
    return {
      toolCalls: [
        {
          id: callId,
          input: { message: "Run both approval gates in order, then return CHILD-GATES-COMPLETE." },
          name: "approval-worker",
        },
      ],
    };
  }
  return completedText;
}

function peekTask(
  request: MockModelRequest,
  callIdPrefix: string,
  completedText: string,
  message: string,
): MockModelResponse | string {
  const callId = `${callIdPrefix}-${request.userMessageCount}`;
  if (resultById(request, callId) === undefined) {
    const taskId = TASK_ID_PATTERN.exec(message)?.[0];
    if (taskId === undefined) throw new Error(`Verification message has no task id: ${message}`);
    return { toolCalls: [{ id: callId, input: { taskIds: [taskId] }, name: "task_peek" }] };
  }
  return completedText;
}

function setupBusyWorker(request: MockModelRequest): MockModelResponse | string {
  const delegated = resultById(request, "child-task-exclusivity-initial-worker");
  if (delegated === undefined) {
    return {
      toolCalls: [
        {
          id: "child-task-exclusivity-initial-worker",
          input: { message: "Return BUSY-WORKER-INITIAL." },
          name: "busy-worker",
        },
      ],
    };
  }

  return "CHILD-TASK-EXCLUSIVITY-READY";
}

function raceBusyWorker(request: MockModelRequest): MockModelResponse | string {
  const first = resultById(request, "child-task-exclusivity-send-a");
  const second = resultById(request, "child-task-exclusivity-send-b");
  if (first === undefined && second === undefined) {
    const initial = resultById(request, "child-task-exclusivity-initial-worker");
    const taskId = findTaskId(initial?.output);
    if (taskId === undefined) throw new Error("Busy-worker race has no initial task id.");
    return {
      toolCalls: [
        {
          id: "child-task-exclusivity-send-a",
          input: { message: "Return BUSY-WORKER-A.", taskId },
          name: "task_send",
        },
        {
          id: "child-task-exclusivity-send-b",
          input: { message: "Return BUSY-WORKER-B.", taskId },
          name: "task_send",
        },
      ],
    };
  }
  return "CHILD-TASK-EXCLUSIVITY-RACE-DONE";
}

function resultById(request: MockModelRequest, id: string): MockModelToolResult | undefined {
  return request.toolResults.find((result) => result.id === id);
}

function findTaskId(value: unknown): string | undefined {
  if (typeof value === "string") return TASK_ID_PATTERN.exec(value)?.[0];
  if (Array.isArray(value)) {
    for (const entry of value) {
      const taskId = findTaskId(entry);
      if (taskId !== undefined) return taskId;
    }
    return undefined;
  }
  if (value !== null && typeof value === "object") {
    const taskId = Reflect.get(value, "taskId");
    if (typeof taskId === "string") return taskId;
    for (const entry of Object.values(value)) {
      const nested = findTaskId(entry);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

const base = e2eAgentConfig();

export default defineAgent({
  ...base,
  experimental: { ...base.experimental, tasks: true },
  // These evals target orchestration, not model planning. Keep every suite
  // deterministic while retaining the workflow-world override from `base`.
  model: mockModel(respond),
  modelContextWindowTokens: 1_000_000,
});
