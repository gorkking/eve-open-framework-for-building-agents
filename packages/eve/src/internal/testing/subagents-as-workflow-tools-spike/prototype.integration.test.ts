import { describe, expect, it } from "vitest";

import { getRun } from "#internal/workflow/runtime.js";
import type { JsonObject, JsonValue } from "#shared/json.js";

import { dispatchSubagentWorkflowTool, dispatchWorkflowTool } from "./driver.js";
import {
  PROTOTYPE_TRANSCRIPT_STREAM,
  defineRemoteSubagent,
  defineSubagent,
  defineWorkflowToolProbe,
  type PrototypeTranscriptEntry,
  type WorkflowBackedSubagentTool,
  type WorkflowSubagentTarget,
} from "./prototype.js";

describe("workflow-backed subagent tool spike", () => {
  it("dispatches an ordinary defineTool executor as an addressable workflow run", async () => {
    const context = {
      callId: "call-probe-1",
      parentSessionId: "session-parent-1",
      toolName: "durable_probe",
    };
    const dispatch = await dispatchWorkflowTool(
      defineWorkflowToolProbe(),
      { value: "durable" },
      context,
    );

    await expect(dispatch.result).resolves.toEqual({ ...context, value: "durable" });
    expect(dispatch.runId).toEqual(expect.any(String));
  });

  it.each([
    {
      expectedTarget: { kind: "local", nodeId: "subagents/research" },
      label: "local",
      tool: defineSubagent({
        description: "Research locally",
        nodeId: "subagents/research",
      }),
    },
    {
      expectedTarget: {
        kind: "remote",
        nodeId: "remote/reviewer",
        url: "https://reviewer.example.com",
      },
      label: "remote",
      tool: defineRemoteSubagent({
        description: "Review remotely",
        nodeId: "remote/reviewer",
        url: "https://reviewer.example.com",
      }),
    },
  ] satisfies readonly {
    expectedTarget: WorkflowSubagentTarget;
    label: string;
    tool: WorkflowBackedSubagentTool;
  }[])(
    "runs the $label executor through progress, HITL, and canonical output",
    async ({ expectedTarget, label, tool }) => {
      const callId = `call-${label}-1`;
      const dispatch = await dispatchSubagentWorkflowTool(
        tool,
        { message: `Investigate through the ${label} executor` },
        {
          callId,
          parentSessionId: "session-parent-1",
          toolName: `${label}_research`,
        },
      );
      const reader = getRun(dispatch.runId)
        .getReadable<PrototypeTranscriptEntry>({ namespace: PROTOTYPE_TRANSCRIPT_STREAM })
        .getReader();

      try {
        expect(dispatch.executorRunId).not.toBe(dispatch.runId);
        await expect(within(readNext(reader), `${label} progress`)).resolves.toEqual({
          callId,
          direction: "child-to-parent",
          envelope: {
            kind: "task_post_message",
            message: `Started ${label} executor ${expectedTarget.nodeId}`,
            mode: "queue",
          },
        });
        await expect(within(readNext(reader), `${label} input request`)).resolves.toEqual({
          callId,
          direction: "child-to-parent",
          envelope: {
            kind: "input.required",
            prompt: `Approve ${label} executor ${expectedTarget.nodeId}?`,
            requestId: dispatch.inputRequestId,
          },
        });

        await dispatch.respond({ approved: true });

        const expectedExecutor: JsonObject =
          expectedTarget.kind === "remote"
            ? {
                kind: expectedTarget.kind,
                nodeId: expectedTarget.nodeId,
                url: expectedTarget.url,
              }
            : { kind: expectedTarget.kind, nodeId: expectedTarget.nodeId };
        const expectedOutput: JsonValue = {
          approved: { approved: true },
          executor: expectedExecutor,
          message: `Investigate through the ${label} executor`,
        };
        await expect(
          within(dispatch.executorResult, `${label} executor settlement`),
        ).resolves.toEqual(expectedOutput);
        await expect(within(dispatch.result, `${label} tool settlement`)).resolves.toEqual(
          expectedOutput,
        );
        await expect(within(readNext(reader), `${label} input response`)).resolves.toEqual({
          callId,
          direction: "parent-to-child",
          envelope: {
            kind: "input.response",
            requestId: dispatch.inputRequestId,
            value: { approved: true },
          },
        });
        await expect(within(readNext(reader), `${label} output`)).resolves.toEqual({
          callId,
          direction: "child-to-parent",
          envelope: { kind: "output", value: expectedOutput },
        });
      } finally {
        await reader.cancel("prototype transcript read complete").catch(() => {});
        reader.releaseLock();
      }
    },
  );
});

async function readNext(
  reader: ReadableStreamDefaultReader<PrototypeTranscriptEntry>,
): Promise<PrototypeTranscriptEntry> {
  const next = await reader.read();
  if (next.done) throw new Error("Prototype transcript closed before the expected entry.");
  return next.value;
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
