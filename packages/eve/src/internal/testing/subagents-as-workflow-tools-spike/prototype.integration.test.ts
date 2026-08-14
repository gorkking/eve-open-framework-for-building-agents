import { describe, expect, it } from "vitest";

import { getRun, resumeHook, start, type WorkflowFunction } from "#internal/workflow/runtime.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import type { JsonValue } from "#shared/json.js";

import {
  CHILD_ENVELOPE_STREAM,
  PARENT_ENVELOPE_STREAM,
  defineRemoteSubagent,
  defineSubagent,
  defineWorkflowToolProbe,
  type ChildInputEnvelope,
  type ParentTaskEnvelope,
  type SubagentWorkflowInvocationContext,
  type SubagentToolInput,
  type WorkflowToolInvocationContext,
  type WorkflowToolProbeInput,
  type WorkflowToolProbeOutput,
} from "./prototype.js";

describe("workflow-backed subagent tool spike", () => {
  it("starts an ordinary defineTool executor as an addressable workflow run", async () => {
    const tool = defineWorkflowToolProbe();
    const workflow = tool.execute;
    assertWorkflowFunction<
      [WorkflowToolProbeInput, WorkflowToolInvocationContext],
      WorkflowToolProbeOutput
    >(workflow);
    const context: WorkflowToolInvocationContext = {
      callId: "call-probe-1",
      parentSessionId: "session-parent-1",
      toolName: "durable_probe",
    };

    expect(workflow.workflowId).toContain("executeWorkflowToolProbe");
    const run = await start(workflow, [{ value: "durable" }, context]);

    await expect(run.returnValue).resolves.toEqual({ ...context, value: "durable" });
    expect(run.runId).toEqual(expect.any(String));
  });

  it("keeps advisory messages, HITL, and canonical output as distinct envelopes", async () => {
    const remoteTool = defineRemoteSubagent({
      description: "Review remotely",
      nodeId: "remote/reviewer",
      url: "https://reviewer.example.com",
    });
    const tool = defineSubagent({
      description: "Research locally",
      nodeId: "subagents/research",
    });
    const remoteWorkflow = remoteTool.execute;
    assertWorkflowFunction<[SubagentToolInput, SubagentWorkflowInvocationContext], JsonValue>(
      remoteWorkflow,
    );
    const workflow = tool.execute;
    assertWorkflowFunction<[SubagentToolInput, SubagentWorkflowInvocationContext], JsonValue>(
      workflow,
    );
    const context: SubagentWorkflowInvocationContext = {
      callId: "call-research-1",
      parentSessionId: "session-parent-1",
      taskId: "task-research-1",
      taskInboxToken: "task-inbox-research-1",
      toolName: "research",
    };

    // A workflow-backed execute is an addressable Workflow function, not a
    // function the harness invokes directly inside its model/tool step.
    expect(remoteWorkflow.workflowId).toContain("executeRemoteSubagent");
    expect(workflow.workflowId).toContain("executeLocalSubagent");
    const run = await start(workflow, [{ message: "Investigate the regression" }, context]);
    await within(waitForHook(run, { token: context.taskInboxToken }), "task inbox registration");

    await within(
      resumeHook(context.taskInboxToken, {
        kind: "task_post_message",
        message: "Found the failing boundary",
        mode: "queue",
      }),
      "task_post_message delivery",
    );
    await within(
      resumeHook(context.taskInboxToken, {
        kind: "input.required",
        prompt: "May I inspect the private trace?",
        requestId: "request-1",
      }),
      "input.required delivery",
    );
    await within(
      resumeHook(context.taskInboxToken, {
        kind: "input.response",
        requestId: "request-1",
        value: { approved: true },
      }),
      "input.response delivery",
    );
    await within(
      resumeHook(context.taskInboxToken, {
        kind: "output",
        value: { conclusion: "The adapter owns the cross-session wire." },
      }),
      "canonical output delivery",
    );

    await expect(within(run.returnValue, "workflow settlement")).resolves.toEqual({
      conclusion: "The adapter owns the cross-session wire.",
    });

    const settledRun = getRun(run.runId);
    await expect(
      within(
        drain<ParentTaskEnvelope>(
          settledRun.getReadable<ParentTaskEnvelope>({ namespace: PARENT_ENVELOPE_STREAM }),
        ),
        "parent envelope drain",
      ),
    ).resolves.toEqual([
      {
        callId: context.callId,
        kind: "task_post_message",
        message: "Found the failing boundary",
        mode: "queue",
        taskId: context.taskId,
      },
      {
        callId: context.callId,
        kind: "input.required",
        prompt: "May I inspect the private trace?",
        requestId: "request-1",
        taskId: context.taskId,
      },
    ]);
    await expect(
      within(
        drain<ChildInputEnvelope>(
          settledRun.getReadable<ChildInputEnvelope>({ namespace: CHILD_ENVELOPE_STREAM }),
        ),
        "child envelope drain",
      ),
    ).resolves.toEqual([
      {
        kind: "input.response",
        requestId: "request-1",
        taskId: context.taskId,
        value: { approved: true },
      },
    ]);
  });
});

function assertWorkflowFunction<TArgs extends unknown[], TReturn>(
  value: unknown,
): asserts value is WorkflowFunction<TArgs, TReturn> & { readonly workflowId: string } {
  if (
    typeof value !== "function" ||
    !("workflowId" in value) ||
    typeof value.workflowId !== "string"
  ) {
    throw new Error("Expected a compiler-transformed workflow function.");
  }
}

async function drain<T>(
  stream: ReadableStream<T> & { readonly getTailIndex: () => Promise<number> },
): Promise<T[]> {
  const values: T[] = [];
  const tailIndex = await stream.getTailIndex();
  const reader = stream.getReader();
  try {
    for (let index = 0; index <= tailIndex; index += 1) {
      const next = await reader.read();
      if (next.done) break;
      values.push(next.value);
    }
    return values;
  } finally {
    await reader.cancel("spike stream read complete").catch(() => {});
    reader.releaseLock();
  }
}

async function within<T>(promise: Promise<T>, label: string, timeoutMs = 5_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
