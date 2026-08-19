import { loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import type { ToolExecuteOptions } from "#shared/tool-definition.js";
import type { TaskExec } from "#shared/tool-task.js";

export interface BackgroundExecutableTool {
  readonly execute: (input: unknown, options: ToolExecuteOptions, task: TaskExec) => unknown;
  readonly name: string;
}

export interface BackgroundToolCall {
  readonly callId: string;
  readonly definition: BackgroundExecutableTool;
  readonly input: unknown;
}

export interface BackgroundToolCallBatch {
  readonly calls: readonly BackgroundToolCall[];
  register(call: BackgroundToolCall): void;
}

export interface BackgroundToolExecutor {
  execute(input: {
    readonly batch: BackgroundToolCallBatch;
    readonly definition: BackgroundExecutableTool;
    readonly options: ToolExecuteOptions;
    readonly toolInput: unknown;
  }): Promise<unknown>;
}

export const BackgroundToolExecutorKey = new ContextKey<BackgroundToolExecutor>(
  "eve.internal.backgroundToolExecution",
);

export function createBackgroundToolCallBatch(): BackgroundToolCallBatch {
  const calls: BackgroundToolCall[] = [];
  const callIds = new Set<string>();
  return {
    calls,
    register(call) {
      if (callIds.has(call.callId)) {
        throw new Error(`Background tool call "${call.callId}" was registered more than once.`);
      }
      callIds.add(call.callId);
      calls.push(call);
    },
  };
}

export async function executeBackgroundToolCall(input: {
  readonly batch: BackgroundToolCallBatch;
  readonly definition: BackgroundExecutableTool;
  readonly options: ToolExecuteOptions;
  readonly toolInput: unknown;
}): Promise<unknown> {
  return await loadContext().require(BackgroundToolExecutorKey).execute(input);
}
