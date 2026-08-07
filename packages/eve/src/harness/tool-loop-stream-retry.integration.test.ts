import { type LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessEmitFn, HarnessSession, ToolLoopHarnessConfig } from "#harness/types.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

type StreamResult = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
} as const;

function createSession(): HarnessSession {
  return {
    agent: {
      modelReference: { id: "retry-integration-model" },
      system: "You are a test assistant.",
      tools: [],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:retry-integration-session",
    history: [
      { content: "Complete the long task.", role: "user" },
      { content: "Prior work is complete.", role: "assistant" },
    ],
    sessionId: "retry-integration-session",
  };
}

function createEventCollector(): {
  readonly emit: HarnessEmitFn;
  readonly events: UnstampedMessageStreamEvent[];
} {
  const events: UnstampedMessageStreamEvent[] = [];
  return {
    emit: async (event) => {
      events.push(event);
    },
    events,
  };
}

function createConfig(model: LanguageModel, emit: HarnessEmitFn): ToolLoopHarnessConfig {
  return {
    handleEvent: emit,
    mode: "task",
    resolveModel: vi.fn().mockResolvedValue(model),
    tools: new Map(),
  };
}

function enqueueOverload(
  controller: ReadableStreamDefaultController<StreamPart>,
  partialText?: string,
): void {
  controller.enqueue({ type: "stream-start", warnings: [] });
  if (partialText !== undefined) {
    controller.enqueue({ id: "partial", type: "text-start" });
    controller.enqueue({ delta: partialText, id: "partial", type: "text-delta" });
    controller.enqueue({ id: "partial", type: "text-end" });
  }
  controller.enqueue({
    error: { message: "Overloaded", type: "overloaded_error" },
    type: "error",
  });
  controller.close();
}

function enqueueTextSuccess(
  controller: ReadableStreamDefaultController<StreamPart>,
  text: string,
): void {
  controller.enqueue({ type: "stream-start", warnings: [] });
  controller.enqueue({ id: "answer", type: "text-start" });
  controller.enqueue({ delta: text, id: "answer", type: "text-delta" });
  controller.enqueue({ id: "answer", type: "text-end" });
  controller.enqueue({
    finishReason: { raw: undefined, unified: "stop" },
    type: "finish",
    usage,
  });
  controller.close();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tool loop streamed provider retries", () => {
  it("retries an overloaded stream and preserves prior task work", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    let attempt = 0;
    const doStream = vi.fn(async () => ({
      stream: new ReadableStream<StreamPart>({
        start(controller) {
          attempt += 1;
          if (attempt === 1) {
            enqueueOverload(controller, "Discard this partial response.");
            return;
          }
          enqueueTextSuccess(controller, "Recovered answer.");
        },
      }),
    }));
    const model = new MockLanguageModelV3({
      doStream,
      modelId: "retry-integration-model",
      provider: "eve-integration-mock",
    });
    const { emit, events } = createEventCollector();

    const result = await createToolLoopHarness(createConfig(model, emit))(createSession(), {
      message: "Continue.",
    });

    expect(doStream).toHaveBeenCalledTimes(2);
    expect(result.next).toEqual({ done: true, output: "Recovered answer." });
    expect(result.session.history).toContainEqual({
      content: "Prior work is complete.",
      role: "assistant",
    });
    expect(JSON.stringify(result.session.history)).toContain("Recovered answer.");
    expect(JSON.stringify(result.session.history)).not.toContain("Discard this partial response.");
    const stepStarted = events.filter((event) => event.type === "step.started");
    const attempts = events.filter((event) => event.type === "attempt.started");
    expect(stepStarted).toHaveLength(1);
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts.map((event) => event.data.attemptId)).size).toBe(2);
    expect(attempts.every((event) => event.data.stepId === stepStarted[0]?.data.stepId)).toBe(true);
    const completed = events.filter((event) => event.type === "step.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]?.data.attemptId).toBe(attempts[1]?.data.attemptId);
    expect(events.filter((event) => event.type === "step.failed")).toHaveLength(0);
    expect(events.filter((event) => event.type === "turn.failed")).toHaveLength(0);
    expect(events.filter((event) => event.type === "session.failed")).toHaveLength(0);
  });

  it("fails once after the overloaded retry attempts are exhausted", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const doStream = vi.fn(async () => ({
      stream: new ReadableStream<StreamPart>({
        start(controller) {
          enqueueOverload(controller);
        },
      }),
    }));
    const model = new MockLanguageModelV3({
      doStream,
      modelId: "retry-integration-model",
      provider: "eve-integration-mock",
    });
    const { emit, events } = createEventCollector();

    const result = await createToolLoopHarness(createConfig(model, emit))(createSession(), {
      message: "Continue.",
    });

    expect(doStream).toHaveBeenCalledTimes(3);
    // The exhausted failure reports the catalog's curated summary for the
    // overloaded shape rather than the provider's raw "Overloaded", with
    // the remediation hint riding along in the parent-facing output.
    expect(result.next).toMatchObject({
      done: true,
      isError: true,
      output:
        "The model provider is overloaded or timing out upstream of AI Gateway. " +
        "This is transient — retry shortly, or switch models with `/model` in `eve dev`.",
    });
    const attempts = events.filter((event) => event.type === "attempt.started");
    const failed = events.filter((event) => event.type === "step.failed");
    expect(attempts).toHaveLength(3);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.data.attemptId).toBe(attempts.at(-1)?.data.attemptId);
    expect(failed[0]?.data.stepId).toBe(attempts.at(-1)?.data.stepId);
    expect(events.filter((event) => event.type === "turn.failed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "session.failed")).toHaveLength(1);
  });
});
