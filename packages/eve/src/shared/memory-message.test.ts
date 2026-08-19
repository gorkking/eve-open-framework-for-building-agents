import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import {
  attributeMemoryMessage,
  readMemoryMessageAttribution,
  stripMemoryMessageAttribution,
} from "#shared/memory-message.js";

describe("memory message attribution", () => {
  it("round-trips durable attribution and removes it at the model boundary", () => {
    const ordinary = { content: "remembered", role: "user" } as const;
    const attributed = attributeMemoryMessage(ordinary, {
      scope: { key: "mem_key", namespace: "app", value: "user-1" },
      slot: "user",
    });

    expect(readMemoryMessageAttribution(attributed)).toEqual({
      scope: { key: "mem_key", namespace: "app", value: "user-1" },
      slot: "user",
    });
    expect(stripMemoryMessageAttribution(attributed)).toEqual(ordinary);
    expect(readMemoryMessageAttribution(stripMemoryMessageAttribution(attributed))).toBeNull();
  });

  it("preserves unrelated metadata while removing eve attribution", () => {
    const attributed = attributeMemoryMessage(
      {
        content: "remembered",
        metadata: { application: "value" },
        role: "user",
      } as ModelMessage & { readonly metadata: Readonly<Record<string, unknown>> },
      {
        scope: { key: "mem_key", namespace: "app", value: "user-1" },
        slot: "user",
      },
    );

    expect(stripMemoryMessageAttribution(attributed)).toEqual({
      content: "remembered",
      metadata: { application: "value" },
      role: "user",
    });
  });
});
