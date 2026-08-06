import { jsonSchema, type LanguageModel, type ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { hasPendingInputBatch, setPendingInputBatch } from "#harness/input-requests.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessSession, ToolLoopHarnessConfig } from "#harness/types.js";

const usage = {
  inputTokens: {
    cacheRead: undefined,
    cacheWrite: undefined,
    noCache: 1,
    total: 1,
  },
  outputTokens: {
    reasoning: undefined,
    text: 1,
    total: 1,
  },
};

const toolCall = {
  input: { command: "pwd" },
  toolCallId: "call-1",
  toolName: "bash",
  type: "tool-call" as const,
};

const approvalRequest = {
  approvalId: "approval-1",
  toolCallId: toolCall.toolCallId,
  type: "tool-approval-request" as const,
};

function createPendingApprovalSession(
  history: readonly ModelMessage[] = [{ content: "Run pwd.", role: "user" }],
): HarnessSession {
  const session: HarnessSession = {
    agent: {
      modelReference: { id: "generate-approval-resume-model" },
      system: "You are a test assistant.",
      tools: [
        {
          description: "Run a shell command.",
          inputSchema: { type: "object" },
          name: toolCall.toolName,
        },
      ],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:generate-approval-resume-session",
    history: [...history],
    sessionId: "generate-approval-resume-session",
  };

  return setPendingInputBatch({
    requests: [
      {
        action: {
          callId: toolCall.toolCallId,
          input: toolCall.input,
          kind: "tool-call",
          toolName: toolCall.toolName,
        },
        allowFreeform: false,
        display: "confirmation",
        kind: "tool-approval",
        options: [
          { id: "approve", label: "Yes" },
          { id: "deny", label: "No" },
        ],
        prompt: "Approve tool call: bash",
        requestId: approvalRequest.approvalId,
      },
    ],
    responseMessages: [
      {
        content: [toolCall, approvalRequest],
        role: "assistant",
      },
    ],
    session,
  });
}

function createHarnessFixture() {
  const execute = vi.fn(async () => "/workspace");
  const model = new MockLanguageModelV4({
    doGenerate: {
      content: [{ text: "The command returned /workspace.", type: "text" }],
      finishReason: { raw: undefined, unified: "stop" },
      usage,
      warnings: [],
    },
    modelId: "generate-approval-resume-model",
    provider: "eve-integration-mock",
  });
  const tools: ToolLoopHarnessConfig["tools"] = new Map([
    [
      toolCall.toolName,
      {
        description: "Run a shell command.",
        execute,
        inputSchema: jsonSchema({ type: "object" }),
        name: toolCall.toolName,
        toModelOutput: (output) => {
          if (typeof output !== "string") {
            throw new TypeError("Expected the bash test tool to return a string.");
          }
          return { type: "text", value: `canonical:${output}` };
        },
      },
    ],
  ]);
  const harness = createToolLoopHarness({
    mode: "conversation",
    resolveModel: async (): Promise<LanguageModel> => model,
    tools,
  });

  return { execute, harness, model };
}

function findPart(
  messages: readonly ModelMessage[],
  type: "tool-approval-response" | "tool-call" | "tool-result",
): unknown {
  for (const message of messages) {
    if (
      (message.role !== "assistant" && message.role !== "tool") ||
      !Array.isArray(message.content)
    ) {
      continue;
    }
    const part = message.content.find((candidate) => candidate.type === type);
    if (part !== undefined) return part;
  }
  return undefined;
}

describe("tool loop generate approval resume (real AI SDK)", () => {
  it("persists the approved pre-model tool result without an event handler", async () => {
    const { execute, harness, model } = createHarnessFixture();

    const result = await harness(createPendingApprovalSession(), {
      inputResponses: [{ optionId: "approve", requestId: approvalRequest.approvalId }],
    });

    expect(model.doGenerateCalls).toHaveLength(1);
    expect(model.doStreamCalls).toHaveLength(0);
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      toolCall.input,
      expect.objectContaining({ toolCallId: toolCall.toolCallId }),
    );

    const providerPrompt = model.doGenerateCalls[0]?.prompt ?? [];
    expect(findPart(providerPrompt, "tool-result")).toMatchObject({
      output: { type: "text", value: "canonical:/workspace" },
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
    });

    expect(result.session.history.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "assistant",
    ]);
    expect(findPart(result.session.history, "tool-call")).toEqual(toolCall);
    expect(findPart(result.session.history, "tool-approval-response")).toMatchObject({
      approvalId: approvalRequest.approvalId,
      approved: true,
    });
    expect(findPart(result.session.history, "tool-result")).toMatchObject({
      output: { type: "text", value: "canonical:/workspace" },
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
    });
    expect(result.session.history.at(-1)).toMatchObject({
      content: [{ text: "The command returned /workspace.", type: "text" }],
      role: "assistant",
    });
  });

  it("resumes an approval after an intervening completed turn", async () => {
    const { execute, harness, model } = createHarnessFixture();
    const interveningHistory: ModelMessage[] = [
      { content: "Run pwd.", role: "user" },
      { content: "While that waits, explain the current directory.", role: "user" },
      {
        content: [{ text: "The current directory contains the active workspace.", type: "text" }],
        role: "assistant",
      },
    ];

    const result = await harness(createPendingApprovalSession(interveningHistory), {
      inputResponses: [{ optionId: "approve", requestId: approvalRequest.approvalId }],
    });

    expect(model.doGenerateCalls).toHaveLength(1);
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      toolCall.input,
      expect.objectContaining({ toolCallId: toolCall.toolCallId }),
    );

    const providerPrompt = model.doGenerateCalls[0]?.prompt ?? [];
    const interveningAnswerIndex = providerPrompt.findIndex(
      (message) =>
        message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some(
          (part) =>
            part.type === "text" &&
            part.text === "The current directory contains the active workspace.",
        ),
    );
    const approvalCallIndex = providerPrompt.findIndex(
      (message) =>
        message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some(
          (part) => part.type === "tool-call" && part.toolCallId === toolCall.toolCallId,
        ),
    );
    expect(interveningAnswerIndex).toBeGreaterThanOrEqual(0);
    expect(approvalCallIndex).toBeGreaterThan(interveningAnswerIndex);
    expect(findPart(providerPrompt, "tool-result")).toMatchObject({
      output: { type: "text", value: "canonical:/workspace" },
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
    });

    expect(result.session.history.map((message) => message.role)).toEqual([
      "user",
      "user",
      "assistant",
      "assistant",
      "tool",
      "tool",
      "assistant",
    ]);
    expect(result.session.history.slice(0, interveningHistory.length)).toEqual(interveningHistory);
    expect(findPart(result.session.history, "tool-approval-response")).toMatchObject({
      approvalId: approvalRequest.approvalId,
      approved: true,
    });
    expect(hasPendingInputBatch(result.session.state)).toBe(false);
  });
});
