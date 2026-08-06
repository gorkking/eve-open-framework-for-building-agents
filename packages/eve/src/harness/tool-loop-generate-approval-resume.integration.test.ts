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

const secondToolCall = {
  input: { path: "notes.txt" },
  toolCallId: "call-2",
  toolName: "write_file",
  type: "tool-call" as const,
};

const secondApprovalRequest = {
  approvalId: "approval-2",
  toolCallId: secondToolCall.toolCallId,
  type: "tool-approval-request" as const,
};

interface ApprovalEntry {
  readonly approvalRequest: typeof approvalRequest | typeof secondApprovalRequest;
  readonly toolCall: typeof toolCall | typeof secondToolCall;
}

const singleApproval: readonly ApprovalEntry[] = [{ approvalRequest, toolCall }];
const approvalGroup: readonly ApprovalEntry[] = [
  { approvalRequest, toolCall },
  { approvalRequest: secondApprovalRequest, toolCall: secondToolCall },
];

function createPendingApprovalSession(
  history: readonly ModelMessage[] = [{ content: "Run pwd.", role: "user" }],
  approvals: readonly ApprovalEntry[] = singleApproval,
): HarnessSession {
  const session: HarnessSession = {
    agent: {
      modelReference: { id: "generate-approval-resume-model" },
      system: "You are a test assistant.",
      tools: approvals.map(({ toolCall: entry }) => ({
        description: `Run ${entry.toolName}.`,
        inputSchema: { type: "object" },
        name: entry.toolName,
      })),
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:generate-approval-resume-session",
    history: [...history],
    sessionId: "generate-approval-resume-session",
  };

  return setPendingInputBatch({
    requests: approvals.map(({ approvalRequest: request, toolCall: entry }) => {
      return {
        action: {
          callId: entry.toolCallId,
          input: entry.input,
          kind: "tool-call",
          toolName: entry.toolName,
        },
        allowFreeform: false,
        display: "confirmation",
        kind: "tool-approval",
        options: [
          { id: "approve", label: "Yes" },
          { id: "deny", label: "No" },
        ],
        prompt: `Approve tool call: ${entry.toolName}`,
        requestId: request.approvalId,
      } as const;
    }),
    responseMessages: [
      {
        content: approvals.flatMap(({ approvalRequest: request, toolCall: entry }) => [
          entry,
          request,
        ]),
        role: "assistant",
      },
    ],
    session,
  });
}

function createHarnessFixture(approvals: readonly ApprovalEntry[] = singleApproval) {
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
  const tools: ToolLoopHarnessConfig["tools"] = new Map(
    approvals.map(({ toolCall: entry }) => [
      entry.toolName,
      {
        description: "Run a shell command.",
        execute,
        inputSchema: jsonSchema({ type: "object" }),
        name: entry.toolName,
        toModelOutput: (output) => {
          if (typeof output !== "string") {
            throw new TypeError("Expected the bash test tool to return a string.");
          }
          return { type: "text", value: `canonical:${output}` };
        },
      },
    ]),
  );
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

function findParts(
  messages: readonly ModelMessage[],
  type: "tool-approval-response" | "tool-call" | "tool-result",
): unknown[] {
  const parts: unknown[] = [];
  for (const message of messages) {
    if (
      (message.role !== "assistant" && message.role !== "tool") ||
      !Array.isArray(message.content)
    ) {
      continue;
    }
    parts.push(...message.content.filter((candidate) => candidate.type === type));
  }
  return parts;
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
    expect(hasPendingInputBatch(result.session.state)).toBe(false);
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
      { content: "What kind of files might it contain?", role: "user" },
      {
        content: [{ text: "It may contain source files and configuration.", type: "text" }],
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
            part.type === "text" && part.text === "It may contain source files and configuration.",
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

  it("denies an approval after an intervening completed turn", async () => {
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
      inputResponses: [{ optionId: "deny", requestId: approvalRequest.approvalId }],
    });

    expect(model.doGenerateCalls).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();
    expect(findPart(model.doGenerateCalls[0]?.prompt ?? [], "tool-result")).toMatchObject({
      output: { reason: "Tool execution was denied.", type: "execution-denied" },
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
    });
    expect(findPart(result.session.history, "tool-approval-response")).toMatchObject({
      approvalId: approvalRequest.approvalId,
      approved: false,
    });
    expect(result.session.history.slice(0, interveningHistory.length)).toEqual(interveningHistory);
    expect(hasPendingInputBatch(result.session.state)).toBe(false);
  });

  it("resumes a suffix group with mixed approval outcomes after an intervening turn", async () => {
    const { execute, harness, model } = createHarnessFixture(approvalGroup);
    const interveningHistory: ModelMessage[] = [
      { content: "Run pwd and write notes.txt.", role: "user" },
      { content: "While those wait, summarize the workspace.", role: "user" },
      {
        content: [{ text: "The workspace contains source and configuration files.", type: "text" }],
        role: "assistant",
      },
    ];

    const result = await harness(createPendingApprovalSession(interveningHistory, approvalGroup), {
      inputResponses: [
        { optionId: "approve", requestId: approvalRequest.approvalId },
        { optionId: "deny", requestId: secondApprovalRequest.approvalId },
      ],
    });

    expect(model.doGenerateCalls).toHaveLength(1);
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      toolCall.input,
      expect.objectContaining({ toolCallId: toolCall.toolCallId }),
    );
    const providerPrompt = model.doGenerateCalls[0]?.prompt ?? [];
    expect(findParts(providerPrompt, "tool-call")).toEqual([toolCall, secondToolCall]);
    expect(findParts(result.session.history, "tool-approval-response")).toEqual([
      expect.objectContaining({ approvalId: approvalRequest.approvalId, approved: true }),
      expect.objectContaining({ approvalId: secondApprovalRequest.approvalId, approved: false }),
    ]);
    expect(findParts(providerPrompt, "tool-result")).toEqual([
      expect.objectContaining({
        output: { reason: "Tool execution was denied.", type: "execution-denied" },
        toolCallId: secondToolCall.toolCallId,
      }),
      expect.objectContaining({
        output: { type: "text", value: "canonical:/workspace" },
        toolCallId: toolCall.toolCallId,
      }),
    ]);
    expect(result.session.history.slice(0, interveningHistory.length)).toEqual(interveningHistory);
    expect(hasPendingInputBatch(result.session.state)).toBe(false);
  });
});
