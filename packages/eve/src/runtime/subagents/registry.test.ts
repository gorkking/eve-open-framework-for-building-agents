import { describe, expect, it } from "vitest";

import {
  getSubagentToolInputJsonSchema,
  resolveSubagentToolSchemaVariant,
  TASK_SUBAGENT_TOOL_INPUT_SCHEMA,
} from "#runtime/subagents/registry.js";

describe("subagent tool input schema variants", () => {
  it("exposes background only on the tasks variant", () => {
    const tasks = getSubagentToolInputJsonSchema("tasks") as {
      additionalProperties?: boolean;
      properties?: Record<string, unknown>;
    };
    const persistent = getSubagentToolInputJsonSchema("persistent") as {
      properties?: Record<string, unknown>;
    };
    const plain = getSubagentToolInputJsonSchema("plain") as {
      properties?: Record<string, unknown>;
    };

    expect(tasks.properties).toHaveProperty("background");
    expect(tasks.properties).toHaveProperty("agentId");
    expect(tasks.additionalProperties).toBe(false);
    expect(persistent.properties).toHaveProperty("agentId");
    expect(persistent.properties).not.toHaveProperty("background");
    expect(plain.properties).not.toHaveProperty("agentId");
    expect(plain.properties).not.toHaveProperty("background");
  });

  it("parses background as an optional boolean", () => {
    expect(TASK_SUBAGENT_TOOL_INPUT_SCHEMA.parse({ message: "m" })).toEqual({ message: "m" });
    expect(TASK_SUBAGENT_TOOL_INPUT_SCHEMA.parse({ background: true, message: "m" })).toEqual({
      background: true,
      message: "m",
    });
    expect(() =>
      TASK_SUBAGENT_TOOL_INPUT_SCHEMA.parse({ background: "yes", message: "m" }),
    ).toThrow();
  });

  it("derives the variant from the agent opt-in state", () => {
    expect(resolveSubagentToolSchemaVariant({})).toBe("plain");
    expect(resolveSubagentToolSchemaVariant({ subagentPersistentSessions: true })).toBe(
      "persistent",
    );
    expect(resolveSubagentToolSchemaVariant({ tasks: true })).toBe("tasks");
    expect(
      resolveSubagentToolSchemaVariant({ subagentPersistentSessions: true, tasks: true }),
    ).toBe("tasks");
  });
});
