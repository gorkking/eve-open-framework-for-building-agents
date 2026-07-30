import { afterEach, describe, expect, it, vi } from "vitest";

import type { BootstrapGenerateResult } from "#runtime/agent/bootstrap-model-utils.js";
import {
  createMockAuthoredRuntimeModel,
  resolveMockAuthoredRuntimeModel,
  shouldMockAuthoredRuntimeModels,
} from "#runtime/agent/mock-model-adapter.js";
import { EMPTY_DELIVERY_SENTINEL } from "#shared/empty-delivery.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

async function generateWithPrompt(
  prompt: unknown,
  tools: readonly unknown[] = [],
  options: Record<string, unknown> = {},
) {
  const model = createMockAuthoredRuntimeModel({
    id: "mock-model-adapter-test",
  } as never);
  const generate = model as unknown as {
    doGenerate(input: { prompt: unknown; tools: readonly unknown[] }): Promise<unknown>;
  };

  return (await generate.doGenerate({
    prompt,
    tools,
    ...options,
  })) as BootstrapGenerateResult;
}

describe("createMockAuthoredRuntimeModel", () => {
  it("activates for the explicit spawned-server test seam", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EVE_MOCK_AUTHORED_MODELS", "1");

    expect(shouldMockAuthoredRuntimeModels()).toBe(true);
  });

  it("preserves explicitly authored eve-mock models when the seam is active", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EVE_MOCK_AUTHORED_MODELS", "1");

    expect(
      resolveMockAuthoredRuntimeModel({
        id: "eve-mock/model",
      } as never),
    ).toBeNull();
  });

  it("activates a matching skill when the available skill line includes a skill path", async () => {
    const result = await generateWithPrompt([
      {
        content: [
          "Available skills\n",
          "Listed skills are available in this run.\n",
          "- weather-skill: Use the weather tool before answering forecast or temperature questions. (path: /home/agent/.agents/skills/weather-skill/SKILL.md)",
        ].join(""),
        role: "system",
      },
      {
        content: "What is the weather in Brooklyn?",
        role: "user",
      },
    ]);

    expect(result.finishReason).toEqual({ raw: undefined, unified: "tool-calls" });
    expect(result.content).toEqual([
      {
        input: JSON.stringify({ skill: "weather-skill" }),
        toolCallId: "call_load_skill",
        toolName: "load_skill",
        type: "tool-call",
      },
    ]);
  });

  it("does not treat the available skills menu as a prompt-layer label", async () => {
    const result = await generateWithPrompt([
      {
        content: [
          "Available skills\n",
          "Listed skills are available in this run.\n",
          "- research: Research unfamiliar topics before answering with confidence. (path: /home/agent/.agents/skills/research/SKILL.md)",
        ].join(""),
        role: "system",
      },
      {
        content: "Hello there",
        role: "user",
      },
    ]);

    expect(result.finishReason).toEqual({ raw: undefined, unified: "stop" });
    expect(result.content).toEqual([
      {
        text: "Bootstrap reply: Hello there",
        type: "text",
      },
    ]);
  });

  it("discovers skills announced in later system history messages", async () => {
    const result = await generateWithPrompt([
      {
        content: [
          "Available skills\n",
          "Listed skills are available in this run.\n",
          "- release: Use for release checklist requests. (path: /home/agent/.agents/skills/release/SKILL.md)",
        ].join(""),
        role: "system",
      },
      {
        content: [
          "Available skills\n",
          "Listed skills are available in this run.\n",
          "- tenant-weather: Use tenant weather policy before answering forecast questions. (path: /home/agent/.agents/skills/tenant-weather/SKILL.md)",
        ].join(""),
        role: "system",
      },
      {
        content: "What is the weather in Brooklyn?",
        role: "user",
      },
    ]);

    expect(result.finishReason).toEqual({ raw: undefined, unified: "tool-calls" });
    expect(result.content).toEqual([
      {
        input: JSON.stringify({ skill: "tenant-weather" }),
        toolCallId: "call_load_skill",
        toolName: "load_skill",
        type: "tool-call",
      },
    ]);
  });

  it("discovers skills advertised inside larger static instruction text", async () => {
    const result = await generateWithPrompt([
      {
        content: [
          "# Identity",
          "",
          "You are a helpful assistant.",
          "",
          "Available skills",
          "Listed skills are available in this run.",
          "- echo-marker: Use when the user asks for the echo marker. (path: /home/agent/.agents/skills/echo-marker/SKILL.md)",
          "",
          "Another section that must not be parsed as skills.",
        ].join("\n"),
        role: "system",
      },
      {
        content: "Please use the echo marker skill and follow its instructions exactly.",
        role: "user",
      },
    ]);

    expect(result.finishReason).toEqual({ raw: undefined, unified: "tool-calls" });
    expect(result.content).toEqual([
      {
        input: JSON.stringify({ skill: "echo-marker" }),
        toolCallId: "call_load_skill",
        toolName: "load_skill",
        type: "tool-call",
      },
    ]);
  });

  it("does not reload a skill already loaded earlier in the session", async () => {
    const result = await generateWithPrompt([
      {
        content: [
          "Available skills",
          "Listed skills are available in this run.",
          "- echo-marker: Use when the user asks for the echo marker. (path: /home/agent/.agents/skills/echo-marker/SKILL.md)",
        ].join("\n"),
        role: "system",
      },
      {
        content: "Please use the echo marker skill and follow its instructions exactly.",
        role: "user",
      },
      {
        content: [
          {
            input: JSON.stringify({ skill: "echo-marker" }),
            toolCallId: "call_load_skill",
            toolName: "load_skill",
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
      {
        content: [
          {
            output: {
              type: "json",
              value: "Reply with exactly the following text and nothing else:\nskill-echo-ok-V1",
            },
            toolCallId: "call_load_skill",
            toolName: "load_skill",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ]);

    expect(result.finishReason).toEqual({ raw: undefined, unified: "stop" });
    expect(result.content).toEqual([
      {
        text: "skill-echo-ok-V1",
        type: "text",
      },
    ]);
  });

  it("reads a relative resource referenced by a loaded packaged skill", async () => {
    const result = await generateWithPrompt(
      [
        {
          content:
            "Available skills\n- toolkit__toolkit-guide: Packaged guide. (path: /workspace/.agents/skills/toolkit__toolkit-guide/SKILL.md)",
          role: "system",
        },
        {
          content: "Use the toolkit guide skill. Read the referenced script and report its token.",
          role: "user",
        },
        {
          content: [
            {
              input: JSON.stringify({ skill: "toolkit__toolkit-guide" }),
              toolCallId: "call_load_skill",
              toolName: "load_skill",
              type: "tool-call",
            },
          ],
          role: "assistant",
        },
        {
          content: [
            {
              output: {
                type: "text",
                value:
                  "For this smoke test, read `scripts/resource-token.js` relative to this SKILL.md and report its token.",
              },
              toolCallId: "call_load_skill",
              toolName: "load_skill",
              type: "tool-result",
            },
          ],
          role: "tool",
        },
      ],
      [
        {
          inputSchema: {
            properties: { filePath: { type: "string" } },
            required: ["filePath"],
            type: "object",
          },
          name: "read_file",
          type: "function",
        },
      ],
    );

    expect(result.content).toEqual([
      {
        input: JSON.stringify({
          filePath: "/workspace/.agents/skills/toolkit__toolkit-guide/scripts/resource-token.js",
        }),
        toolCallId: "call_read_file",
        toolName: "read_file",
        type: "tool-call",
      },
    ]);
  });

  it("never matches load_skill by explicit name in the user message", async () => {
    const result = await generateWithPrompt(
      [
        {
          content: 'Call the load_skill tool with skill "echo-marker".',
          role: "user",
        },
      ],
      [
        {
          inputSchema: {
            properties: { skill: { type: "string" } },
            required: ["skill"],
            type: "object",
          },
          name: "load_skill",
          type: "function",
        },
      ],
    );

    expect(result.finishReason).toEqual({ raw: undefined, unified: "stop" });
    expect(result.content).toEqual([
      {
        text: 'Bootstrap reply: Call the load_skill tool with skill "echo-marker".',
        type: "text",
      },
    ]);
  });

  it("builds ask_question input from prompt text and option labels", async () => {
    const result = await generateWithPrompt(
      [
        {
          content: [
            "Use the ask_question tool exactly once.",
            "Set prompt to: 'Pick a color.'",
            'Provide exactly two options: - id "red", label "Red" - id "blue", label "Blue"',
          ].join("\n"),
          role: "user",
        },
      ],
      [
        {
          inputSchema: {
            properties: {
              allowFreeform: { type: "boolean" },
              options: { type: "array" },
              prompt: { type: "string" },
            },
            type: "object",
          },
          name: "ask_question",
          type: "function",
        },
      ],
    );

    expect(result.finishReason).toEqual({ raw: undefined, unified: "tool-calls" });
    expect(result.content).toEqual([
      {
        input: JSON.stringify({
          prompt: "Pick a color.",
          options: [
            { id: "red", label: "Red" },
            { id: "blue", label: "Blue" },
          ],
        }),
        toolCallId: "call_ask_question",
        toolName: "ask_question",
        type: "tool-call",
      },
    ]);
  });

  it("builds bash command input from a backticked command", async () => {
    const result = await generateWithPrompt(
      [
        {
          content: "Run the bash command `cat /workspace/smoke-marker.txt`.",
          role: "user",
        },
      ],
      [
        {
          inputSchema: {
            properties: {
              command: { type: "string" },
            },
            type: "object",
          },
          name: "bash",
          type: "function",
        },
      ],
    );

    expect(result.finishReason).toEqual({ raw: undefined, unified: "tool-calls" });
    expect(result.content).toEqual([
      {
        input: JSON.stringify({ command: "cat /workspace/smoke-marker.txt" }),
        toolCallId: "call_bash",
        toolName: "bash",
        type: "tool-call",
      },
    ]);
  });

  it("builds anchored string inputs from quoted spans following the property name", async () => {
    const result = await generateWithPrompt(
      [
        {
          content:
            "Call the `structured-echo` tool exactly once with label `schedule-markdown-ok-Q7M3`.",
          role: "user",
        },
      ],
      [
        {
          inputSchema: {
            properties: {
              label: { type: "string" },
            },
            type: "object",
          },
          name: "structured-echo",
          type: "function",
        },
      ],
    );

    expect(result.finishReason).toEqual({ raw: undefined, unified: "tool-calls" });
    expect(result.content).toEqual([
      {
        input: JSON.stringify({ label: "schedule-markdown-ok-Q7M3" }),
        toolCallId: "call_structured_echo",
        toolName: "structured-echo",
        type: "tool-call",
      },
    ]);
  });

  it("anchors multiple quoted properties and ignores unquoted ones", async () => {
    const result = await generateWithPrompt(
      [
        {
          content: `Use the always-throws tool with reason 'smoke' and note: "extra".`,
          role: "user",
        },
      ],
      [
        {
          inputSchema: {
            properties: {
              note: { type: "string" },
              reason: { type: "string" },
            },
            type: "object",
          },
          name: "always-throws",
          type: "function",
        },
      ],
    );

    expect(result.content).toEqual([
      {
        input: JSON.stringify({ note: "extra", reason: "smoke" }),
        toolCallId: "call_always_throws",
        toolName: "always-throws",
        type: "tool-call",
      },
    ]);
  });

  it("keeps the city heuristic when no anchored property matches", async () => {
    const result = await generateWithPrompt(
      [
        {
          content: "Use the get_weather tool to check the weather in Lisbon.",
          role: "user",
        },
      ],
      [
        {
          inputSchema: {
            properties: {
              city: { type: "string" },
            },
            type: "object",
          },
          name: "get_weather",
          type: "function",
        },
      ],
    );

    expect(result.content).toEqual([
      {
        input: JSON.stringify({ city: "Lisbon" }),
        toolCallId: "call_get_weather",
        toolName: "get_weather",
        type: "tool-call",
      },
    ]);
  });

  it("builds empty input for an explicitly empty object schema", async () => {
    const result = await generateWithPrompt(
      [
        {
          content: "Use the wait_for_cancel tool.",
          role: "user",
        },
      ],
      [
        {
          inputSchema: {
            additionalProperties: false,
            properties: {},
            type: "object",
          },
          name: "wait_for_cancel",
          type: "function",
        },
      ],
    );

    expect(result.content).toEqual([
      {
        input: JSON.stringify({}),
        toolCallId: "call_wait_for_cancel",
        toolName: "wait_for_cancel",
        type: "tool-call",
      },
    ]);
  });

  it("replies with exact fixture text from system context", async () => {
    const result = await generateWithPrompt([
      {
        content:
          "When you reply to the next user message, include the exact token ambient-ok-M3K8 verbatim.",
        role: "system",
      },
      {
        content: [
          "Skill (dynamic-tenant-policy)",
          "Reply with exactly the following text and nothing else:",
          "skill-policy-ok-P4K9",
        ].join("\n"),
        role: "system",
      },
      {
        content: "Please use the dynamic tenant policy skill.",
        role: "user",
      },
    ]);

    expect(result.finishReason).toEqual({ raw: undefined, unified: "stop" });
    expect(result.content).toEqual([
      {
        text: "skill-policy-ok-P4K9",
        type: "text",
      },
    ]);
  });

  it("prefers loaded skill exact text over ambient instruction tokens", async () => {
    const result = await generateWithPrompt([
      {
        content:
          "When you reply to the next user message, include the exact token ambient-ok-M3K8 verbatim.",
        role: "system",
      },
      {
        content: [
          {
            output: {
              type: "text",
              value: [
                "Skill (dynamic-tenant-policy)",
                "Reply with exactly the following text and nothing else:",
                "loaded-skill-ok-P4K9",
              ].join("\n"),
            },
            toolCallId: "call_load_skill",
            toolName: "load_skill",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
      {
        content: "Please use the dynamic tenant policy skill.",
        role: "user",
      },
    ]);

    expect(result.finishReason).toEqual({ raw: undefined, unified: "stop" });
    expect(result.content).toEqual([
      {
        text: "loaded-skill-ok-P4K9",
        type: "text",
      },
    ]);
  });

  it("honors exact-token directives delivered as trailing user context", async () => {
    const result = await generateWithPrompt([
      {
        content: "include the exact token clientctx-ok-W7R2 verbatim",
        role: "user",
      },
      {
        content: "Say hello.",
        role: "user",
      },
    ]);

    expect(result.content).toEqual([
      {
        text: "clientctx-ok-W7R2",
        type: "text",
      },
    ]);
  });

  it("does not leak exact-token directives from earlier turns", async () => {
    const result = await generateWithPrompt([
      {
        content: "include the exact token stale-ok-Q9Z1 verbatim",
        role: "user",
      },
      {
        content: "stale-ok-Q9Z1",
        role: "assistant",
      },
      {
        content: "Say hello again.",
        role: "user",
      },
    ]);

    expect(result.content).toEqual([
      {
        text: "Bootstrap reply: Say hello again.",
        type: "text",
      },
    ]);
  });

  it("recalls a simple fact established in an earlier turn", async () => {
    const result = await generateWithPrompt([
      {
        content: "My favorite word is marigold. Remember it.",
        role: "user",
      },
      {
        content: "Bootstrap reply: My favorite word is marigold. Remember it.",
        role: "assistant",
      },
      {
        content: "What is my favorite word? Reply with just the word.",
        role: "user",
      },
    ]);

    expect(result.content).toEqual([
      {
        text: "marigold",
        type: "text",
      },
    ]);
  });

  it("replies with exact string instructions from system context", async () => {
    const result = await generateWithPrompt([
      {
        content:
          "You are a fixture. Reply with the exact string `system-exact-ok-Q8V3` and nothing else.",
        role: "system",
      },
      {
        content: "Please follow the system instruction.",
        role: "user",
      },
    ]);

    expect(result.finishReason).toEqual({ raw: undefined, unified: "stop" });
    expect(result.content).toEqual([
      {
        text: "system-exact-ok-Q8V3",
        type: "text",
      },
    ]);
  });

  it("replies with exact token instructions from system context", async () => {
    const result = await generateWithPrompt([
      {
        content:
          "When you reply to the next user message, include the exact token ambient-only-ok-J5W1 verbatim somewhere in your response.",
        role: "system",
      },
      {
        content: "Please follow the system instruction.",
        role: "user",
      },
    ]);

    expect(result.finishReason).toEqual({ raw: undefined, unified: "stop" });
    expect(result.content).toEqual([
      {
        text: "ambient-only-ok-J5W1",
        type: "text",
      },
    ]);
  });

  it("chains the smoke-test lookup tool pair under the authored-model mock", async () => {
    const tools = [
      {
        description: "Returns a deterministic stepKey.",
        name: "lookup-step-a",
        type: "function",
      },
      {
        description: "Returns the final value for a stepKey.",
        name: "lookup-step-b",
        type: "function",
      },
    ];
    const prompt = [
      {
        content:
          "Call lookup-step-a with topic instrumentation, then call lookup-step-b with the returned stepKey.",
        role: "user",
      },
    ];

    const firstResult = await generateWithPrompt(prompt, tools);
    expect(firstResult.finishReason).toEqual({ raw: undefined, unified: "tool-calls" });
    expect(firstResult.content).toEqual([
      {
        input: JSON.stringify({ topic: "instrumentation" }),
        toolCallId: "call_lookup_step_a",
        toolName: "lookup-step-a",
        type: "tool-call",
      },
    ]);

    const secondResult = await generateWithPrompt(
      [
        ...prompt,
        {
          content: [
            {
              output: { type: "json", value: { stepKey: "K-9F2X" } },
              toolCallId: "call_lookup_step_a",
              toolName: "lookup-step-a",
              type: "tool-result",
            },
          ],
          role: "tool",
        },
      ],
      tools,
    );
    expect(secondResult.finishReason).toEqual({ raw: undefined, unified: "tool-calls" });
    expect(secondResult.content).toEqual([
      {
        input: JSON.stringify({ stepKey: "K-9F2X" }),
        toolCallId: "call_lookup_step_b",
        toolName: "lookup-step-b",
        type: "tool-call",
      },
    ]);
  });

  it("does not reuse a prior turn's tool result after a later user message", async () => {
    const result = await generateWithPrompt([
      {
        content: [
          {
            output: { type: "json", value: { ok: true, value: "prior" } },
            toolCallId: "call_lookup_step_b",
            toolName: "lookup-step-b",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
      {
        content: "Acknowledge the current turn.",
        role: "user",
      },
    ]);

    expect(result.finishReason).toEqual({ raw: undefined, unified: "stop" });
    expect(result.content).toEqual([
      {
        text: "Bootstrap reply: Acknowledge the current turn.",
        type: "text",
      },
    ]);
  });

  it("calls an explicit list of authored tools in parallel", async () => {
    const result = await generateWithPrompt(
      [
        {
          content: [
            "Call tools in parallel: local-sleeper, remote-sleeper",
            'message: "Use wait-for-cancel."',
          ].join("\n"),
          role: "user",
        },
      ],
      ["local-sleeper", "remote-sleeper"].map((name) => ({
        inputSchema: {
          properties: { message: { type: "string" } },
          required: ["message"],
          type: "object",
        },
        name,
        type: "function",
      })),
    );

    expect(result.finishReason).toEqual({ raw: undefined, unified: "tool-calls" });
    expect(result.content).toEqual(
      ["local-sleeper", "remote-sleeper"].map((name) => ({
        input: JSON.stringify({ message: "Use wait-for-cancel." }),
        toolCallId: `call_${name.replaceAll("-", "_")}`,
        toolName: name,
        type: "tool-call",
      })),
    );
  });

  it("delegates directly to a named subagent with only its explicit message", async () => {
    const result = await generateWithPrompt(
      [
        {
          content:
            "Use the echo-marker subagent with message 'ping'. Once it returns, include its output.",
          role: "user",
        },
      ],
      [
        {
          inputSchema: {
            properties: {
              message: { type: "string" },
              outputSchema: { type: "object" },
            },
            required: ["message"],
            type: "object",
          },
          name: "echo-marker",
          type: "function",
        },
      ],
    );

    expect(result.content).toEqual([
      {
        input: JSON.stringify({ message: "ping" }),
        toolCallId: "call_echo_marker",
        toolName: "echo-marker",
        type: "tool-call",
      },
    ]);
  });

  it("extracts a built-in subagent task without the parent follow-up", async () => {
    const result = await generateWithPrompt(
      [
        {
          content: [
            "Use the built-in agent subagent exactly once.",
            "Give the child this task: Return exactly CHILD-OK.",
            "After the child returns, reply with its exact output.",
          ].join(" "),
          role: "user",
        },
      ],
      [
        {
          inputSchema: {
            properties: { message: { type: "string" } },
            required: ["message"],
            type: "object",
          },
          name: "agent",
          type: "function",
        },
      ],
    );

    expect(result.content).toEqual([
      {
        input: JSON.stringify({ message: "Return exactly CHILD-OK." }),
        toolCallId: "call_agent",
        toolName: "agent",
        type: "tool-call",
      },
    ]);
  });

  it("authors a Workflow Promise.all fan-out for explicit subagent messages", async () => {
    const result = await generateWithPrompt(
      [
        {
          content:
            "Use the Workflow tool exactly once to fan out two echo-marker subagent calls with the messages 'workflow alpha' and 'workflow beta' inside one Promise.all.",
          role: "user",
        },
      ],
      [
        {
          inputSchema: {
            properties: { js: { type: "string" } },
            required: ["js"],
            type: "object",
          },
          name: "Workflow",
          type: "function",
        },
        {
          name: "echo-marker",
          type: "function",
        },
      ],
    );

    const content = result.content[0];
    expect(content?.type).toBe("tool-call");
    if (content?.type !== "tool-call") return;
    const input = JSON.parse(content.input) as { js: string };
    expect(content.toolName).toBe("Workflow");
    expect(input.js).toContain("Promise.all");
    expect(input.js).toContain('tools["echo-marker"]');
    expect(input.js).toContain("workflow alpha");
    expect(input.js).toContain("workflow beta");
  });

  it("emits repeated Bash calls with distinct ids and commands in one step", async () => {
    const result = await generateWithPrompt(
      [
        {
          content: [
            "Call the `bash` tool exactly 3 separate times in one tool-use step.",
            "one: `printf one`",
            "two: `printf two`",
            "three: `printf three`",
          ].join("\n"),
          role: "user",
        },
      ],
      [
        {
          inputSchema: {
            properties: { command: { type: "string" } },
            required: ["command"],
            type: "object",
          },
          name: "bash",
          type: "function",
        },
      ],
    );

    expect(result.content).toEqual(
      ["one", "two", "three"].map((value, index) => ({
        input: JSON.stringify({ command: `printf ${value}` }),
        toolCallId: index === 0 ? "call_bash" : `call_bash_${String(index + 1)}`,
        toolName: "bash",
        type: "tool-call",
      })),
    );
  });

  it("sequences repeated and follow-up tools with schema-derived inputs", async () => {
    const tools = [
      {
        inputSchema: {
          additionalProperties: false,
          properties: {},
          type: "object",
        },
        name: "counter",
        type: "function",
      },
      {
        inputSchema: {
          properties: { label: { type: "string" } },
          required: ["label"],
          type: "object",
        },
        name: "report",
        type: "function",
      },
    ];
    const userMessage = {
      content: "Call `counter` two times, then call `report` with label 'done'.",
      role: "user",
    };
    const firstToolResult = {
      content: [
        {
          output: { type: "json", value: { count: 1 } },
          toolCallId: "call_counter",
          toolName: "counter",
          type: "tool-result",
        },
      ],
      role: "tool",
    };
    const secondToolResult = {
      content: [
        {
          output: { type: "json", value: { count: 2 } },
          toolCallId: "call_counter_2",
          toolName: "counter",
          type: "tool-result",
        },
      ],
      role: "tool",
    };

    const repeated = await generateWithPrompt([userMessage, firstToolResult], tools);
    expect(repeated.content).toEqual([
      {
        input: JSON.stringify({}),
        toolCallId: "call_counter_2",
        toolName: "counter",
        type: "tool-call",
      },
    ]);

    const followUp = await generateWithPrompt(
      [userMessage, firstToolResult, secondToolResult],
      tools,
    );
    expect(followUp.content).toEqual([
      {
        input: JSON.stringify({ label: "done" }),
        toolCallId: "call_report",
        toolName: "report",
        type: "tool-call",
      },
    ]);
  });

  it("derives numeric arrays and connection-search fields from fixture wording", async () => {
    const numeric = await generateWithPrompt(
      [
        {
          content: "Use run_python to compute the sum of these integers: 2, 3, and 4.",
          role: "user",
        },
      ],
      [
        {
          inputSchema: {
            properties: {
              numbers: {
                items: { type: "integer" },
                type: "array",
              },
            },
            required: ["numbers"],
            type: "object",
          },
          name: "run_python",
          type: "function",
        },
      ],
    );
    expect(numeric.content).toEqual([
      {
        input: JSON.stringify({ numbers: [2, 3, 4] }),
        toolCallId: "call_run_python",
        toolName: "run_python",
        type: "tool-call",
      },
    ]);

    const connection = await generateWithPrompt(
      [
        {
          content:
            "Use connection_search to find the TfL journey modes operation in the `tfl` connection.",
          role: "user",
        },
      ],
      [
        {
          inputSchema: {
            properties: {
              connection: { type: "string" },
              keywords: { type: "string" },
              limit: { type: "number" },
            },
            required: ["keywords"],
            type: "object",
          },
          name: "connection_search",
          type: "function",
        },
      ],
    );
    expect(connection.content).toEqual([
      {
        input: JSON.stringify({ connection: "tfl", keywords: "TfL journey modes" }),
        toolCallId: "call_connection_search",
        toolName: "connection_search",
        type: "tool-call",
      },
    ]);
  });

  it("uses the empty-delivery sentinel after an explicitly conditional empty result", async () => {
    const result = await generateWithPrompt(
      [
        {
          content: [
            "Call the `check-alerts` tool exactly once with an empty object.",
            "Do not send a message when the returned alerts list is empty.",
          ].join("\n"),
          role: "user",
        },
        {
          content: [
            {
              output: { type: "json", value: { alerts: [] } },
              toolCallId: "call_check_alerts",
              toolName: "check-alerts",
              type: "tool-result",
            },
          ],
          role: "tool",
        },
      ],
      [
        {
          inputSchema: {
            additionalProperties: false,
            properties: {},
            type: "object",
          },
          name: "check-alerts",
          type: "function",
        },
      ],
    );

    expect(result.content).toEqual([
      {
        text: EMPTY_DELIVERY_SENTINEL,
        type: "text",
      },
    ]);
  });

  it("calls final_output with a schema-shaped sample when the tool is offered", async () => {
    const result = await generateWithPrompt(
      [{ content: "Summarize this", role: "user" }],
      [
        {
          name: "final_output",
          type: "function",
          description: "Deliver your final answer.",
          inputSchema: {
            properties: {
              count: { type: "integer" },
              title: { type: "string" },
            },
            required: ["title", "count"],
            type: "object",
          },
        },
      ],
    );

    expect(result.finishReason).toEqual({ raw: undefined, unified: "tool-calls" });
    expect(result.content).toEqual([
      {
        input: JSON.stringify({ title: "structured-output", count: 1 }),
        toolCallId: expect.any(String),
        toolName: "final_output",
        type: "tool-call",
      },
    ]);
  });
});
