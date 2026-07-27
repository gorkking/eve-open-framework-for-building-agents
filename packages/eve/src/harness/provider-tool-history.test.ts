import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import {
  dedupeToolResultsByCallId,
  normalizeProviderToolHistory,
} from "#harness/provider-tool-history.js";

describe("normalizeProviderToolHistory", () => {
  it("preserves text ordering around provider-executed tool results", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will look that up." },
          {
            type: "tool-call",
            toolCallId: "search-1",
            toolName: "web_search",
            input: { objective: "Current result" },
          },
          {
            type: "tool-result",
            toolCallId: "search-1",
            toolName: "web_search",
            output: { type: "json", value: { results: [] } },
          },
          { type: "text", text: "The search returned no results." },
        ],
      },
    ];

    const normalized = normalizeProviderToolHistory({
      messages,
      providerExecutedOutcomeIds: new Set(["search-1"]),
    });

    expect(normalized.messages).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will look that up." },
          {
            type: "tool-call",
            toolCallId: "search-1",
            toolName: "web_search",
            input: { objective: "Current result" },
            providerExecuted: false,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "search-1",
            toolName: "web_search",
            output: { type: "json", value: { results: [] } },
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "The search returned no results." }],
      },
    ]);
    expect(normalized.outcomeEndsResponse).toBe(false);
  });

  it("groups consecutive provider results without changing their order", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "search-1",
            toolName: "web_search",
            input: { objective: "First" },
          },
          {
            type: "tool-call",
            toolCallId: "search-2",
            toolName: "web_search",
            input: { objective: "Second" },
          },
          {
            type: "tool-result",
            toolCallId: "search-2",
            toolName: "web_search",
            output: { type: "json", value: { results: [2] } },
          },
          {
            type: "tool-result",
            toolCallId: "search-1",
            toolName: "web_search",
            output: { type: "json", value: { results: [1] } },
          },
        ],
      },
    ];

    const normalized = normalizeProviderToolHistory({
      messages,
      providerExecutedOutcomeIds: new Set(["search-1", "search-2"]),
    });

    expect(normalized.messages.map((message) => message.role)).toEqual(["assistant", "tool"]);
    expect(normalized.messages[1]?.content).toEqual([
      expect.objectContaining({ toolCallId: "search-2" }),
      expect.objectContaining({ toolCallId: "search-1" }),
    ]);
    expect(normalized.outcomeEndsResponse).toBe(true);
  });

  it("preserves native provider-owned tool history", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "search-1",
            toolName: "web_search",
            input: { query: "Current result" },
            providerExecuted: true,
          },
          {
            type: "tool-result",
            toolCallId: "search-1",
            toolName: "web_search",
            output: { type: "json", value: { results: [] } },
          },
        ],
      },
    ];

    const normalized = normalizeProviderToolHistory({
      messages,
      providerExecutedOutcomeIds: new Set(["search-1"]),
    });

    expect(normalized.messages).toEqual(messages);
    expect(normalized.outcomeEndsResponse).toBe(true);
  });
});

describe("dedupeToolResultsByCallId", () => {
  it("drops a second result for a provider call that already has an inline result", () => {
    // Captured from a live Opus 5 web_search whose arguments failed to parse:
    // the provider returns its own error result inline, and the AI SDK adds a
    // second synthesized tool-error message for the same id.
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "toolu_dup",
            toolName: "web_search",
            input: {},
            providerExecuted: true,
          },
          {
            type: "tool-result",
            toolCallId: "toolu_dup",
            toolName: "web_search",
            output: { type: "error-json", value: { error: "invalid_input" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "toolu_dup",
            toolName: "web_search",
            output: { type: "error-text", value: "AI_InvalidToolInputError" },
          },
        ],
      },
    ];

    const result = dedupeToolResultsByCallId(messages);

    expect(result.droppedCallIds).toEqual(["toolu_dup"]);
    // The inline provider result survives; the empty tool message is pruned.
    expect(result.messages).toEqual([messages[0]]);
  });

  it("keeps distinct client tool results untouched", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "a", toolName: "add", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "a",
            toolName: "add",
            output: { type: "json", value: 1 },
          },
          {
            type: "tool-result",
            toolCallId: "b",
            toolName: "sub",
            output: { type: "json", value: 2 },
          },
        ],
      },
    ];

    const result = dedupeToolResultsByCallId(messages);

    expect(result.droppedCallIds).toEqual([]);
    expect(result.messages).toEqual(messages);
    // Untouched messages keep their identity (no needless copies).
    expect(result.messages[0]).toBe(messages[0]);
    expect(result.messages[1]).toBe(messages[1]);
  });
});
