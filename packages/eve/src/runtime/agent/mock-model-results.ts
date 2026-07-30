import { z } from "#compiled/zod/index.js";

import {
  type BootstrapGenerateResult,
  type BootstrapPrompt,
  getLastUserPromptText,
  getPromptContentText,
} from "#runtime/agent/bootstrap-model-utils.js";
import { BOOTSTRAP_RUNTIME_SYSTEM_PROMPT } from "#runtime/agent/bootstrap.js";
import {
  formatToolOutput,
  resolveMockConversationRecall,
  resolveMockFixtureToken,
} from "#runtime/agent/mock-model-fixtures.js";

export interface BootstrapToolResult {
  readonly isError: boolean;
  readonly output: unknown;
  readonly toolCallId: string;
  readonly toolName: string;
}

const bootstrapWeatherPayloadSchema = z
  .object({
    city: z.string(),
    condition: z.string(),
    summary: z.string(),
    temperatureF: z.number().finite(),
  })
  .strict();

export function createAssistantMessage(prompt: BootstrapPrompt): string {
  const lastUserMessage = getLastUserPromptText(prompt) ?? "Hello from eve";
  const systemLabels = getSystemPromptLabels(prompt);
  const systemProbe = resolveSystemProbe(prompt);
  const fixtureToken = resolveMockFixtureToken(prompt);
  const recalledFact = resolveMockConversationRecall(prompt);

  if (fixtureToken !== null) {
    return fixtureToken;
  }

  if (recalledFact !== null) {
    return recalledFact;
  }

  if (systemLabels.length > 0) {
    if (systemProbe === null) {
      return `Bootstrap reply [${systemLabels.join(", ")}]: ${lastUserMessage}`;
    }

    return `Bootstrap reply [${systemLabels.join(", ")}; probe=${systemProbe}]: ${lastUserMessage}`;
  }

  if (systemProbe !== null) {
    return `Bootstrap reply [probe=${systemProbe}]: ${lastUserMessage}`;
  }

  return `Bootstrap reply: ${lastUserMessage}`;
}

export function formatToolResultReply(
  result: BootstrapToolResult,
  prompt: BootstrapPrompt,
): string {
  if (result.isError) {
    return `Local weather tool failed: ${formatToolOutput(result.output)}`;
  }

  if (isWeatherPayload(result.output)) {
    return `Used local weather tool for ${result.output.city}: ${result.output.condition}, ${result.output.temperatureF}F. ${result.output.summary}`;
  }

  const lastUserMessage = getLastUserPromptText(prompt) ?? "Hello from eve";

  return `Used ${result.toolName} for "${lastUserMessage}": ${formatToolOutput(result.output)}`;
}

export function createToolCallGenerateResult(input: {
  readonly input: unknown;
  readonly inputTokens: number;
  readonly modelId: string;
  readonly outputTokens: number;
  readonly toolCallId: string;
  readonly toolName: string;
}): BootstrapGenerateResult {
  return createToolCallsGenerateResult({
    calls: [
      {
        input: input.input,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
      },
    ],
    inputTokens: input.inputTokens,
    modelId: input.modelId,
    outputTokens: input.outputTokens,
  });
}

export function createToolCallsGenerateResult(input: {
  readonly calls: readonly {
    readonly input: unknown;
    readonly toolCallId: string;
    readonly toolName: string;
  }[];
  readonly inputTokens: number;
  readonly modelId: string;
  readonly outputTokens: number;
}): BootstrapGenerateResult {
  return {
    content: input.calls.map((call) => ({
      input: JSON.stringify(call.input),
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      type: "tool-call",
    })),
    finishReason: { raw: undefined, unified: "tool-calls" },
    response: {
      id: "bootstrap-response",
      modelId: input.modelId,
      timestamp: new Date("2026-03-16T00:00:00.000Z"),
    },
    usage: {
      inputTokens: {
        cacheRead: 0,
        cacheWrite: 0,
        noCache: input.inputTokens,
        total: input.inputTokens,
      },
      outputTokens: {
        reasoning: 0,
        text: input.outputTokens,
        total: input.outputTokens,
      },
    },
    warnings: [],
  } as BootstrapGenerateResult;
}

function getSystemPromptLabels(prompt: BootstrapPrompt): string[] {
  const systemMessages = prompt.filter((message) => message.role === "system");

  if (systemMessages.length === 0) {
    return [];
  }

  const labels = systemMessages.flatMap((message) => {
    const text = getPromptContentText(message.content);

    if (text.startsWith("Available skills\n")) {
      return [];
    }

    const lines = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const extractedLabels: string[] = [];

    for (const line of lines) {
      if (line === BOOTSTRAP_RUNTIME_SYSTEM_PROMPT || line === "Available skills") {
        continue;
      }

      const systemMatch = /^System \((.+)\)$/.exec(line);

      if (systemMatch?.[1]) {
        extractedLabels.push(systemMatch[1]);
        continue;
      }

      const skillMatch = /^Skill \((.+)\)$/.exec(line);

      if (skillMatch?.[1]) {
        extractedLabels.push(skillMatch[1]);
      }
    }

    if (extractedLabels.length > 0) {
      return extractedLabels;
    }

    const fallbackFirstLine = lines.find(
      (line) => line !== BOOTSTRAP_RUNTIME_SYSTEM_PROMPT && line !== "Available skills",
    );

    return fallbackFirstLine === undefined ? [] : [fallbackFirstLine];
  });

  return [...new Set(labels)];
}

function resolveSystemProbe(prompt: BootstrapPrompt): string | null {
  const systemText = prompt
    .filter((message) => message.role === "system")
    .map((message) => getPromptContentText(message.content))
    .join("\n");
  const probeMatch = /hmr-probe:\s*([^\n]+)/iu.exec(systemText);

  return probeMatch?.[1]?.trim() || null;
}

function isWeatherPayload(value: unknown): value is {
  readonly city: string;
  readonly condition: string;
  readonly summary: string;
  readonly temperatureF: number;
} {
  return bootstrapWeatherPayloadSchema.safeParse(value).success;
}
