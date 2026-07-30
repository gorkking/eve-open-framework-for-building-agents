import {
  type BootstrapPrompt,
  getPromptContentText,
} from "#runtime/agent/bootstrap-model-utils.js";
import type { AvailableBootstrapTool } from "#runtime/agent/mock-model-fixtures.js";
import { AGENT_TOOL_NAME } from "#runtime/framework-tools/agent.js";
import { FINAL_OUTPUT_TOOL_NAME } from "#runtime/framework-tools/final-output.js";
import { LOAD_SKILL_TOOL_NAME } from "#runtime/skills/fragment-context.js";
import { WORKFLOW_TOOL_NAME } from "#shared/workflow-sandbox.js";

const LEGACY_SUBAGENT_DIRECTIVE = /\bdelegate\s+to\s+a\s+subagent\s*:\s*(.+)$/iu;
const BUILT_IN_SUBAGENT_DIRECTIVE = /\buse\s+the\s+built-in\s+agent\s+subagent\b/iu;
const WORKFLOW_FAN_OUT_DIRECTIVE = /\buse\s+the\s+Workflow\s+tool\s+exactly\s+once\b/iu;

export interface MockSubagentDelegation {
  readonly message: string;
  readonly tool: AvailableBootstrapTool;
}

export interface MockRepeatedToolCallDirective {
  readonly commands: readonly string[];
  readonly count: number;
  readonly tool: AvailableBootstrapTool;
}

/** Resolves a loaded skill's relative resource instruction to an advertised absolute path. */
export function resolveMockSkillResourcePath(
  prompt: BootstrapPrompt,
  activatedSkillIds: readonly string[],
): string | null {
  const skillId = activatedSkillIds.at(-1);
  if (skillId === undefined) {
    return null;
  }

  const skillResultText = getLatestSkillResultText(prompt);
  const relativePath = /\bread\s+[`"']([^`"']+)[`"']\s+relative\s+to\s+this\s+SKILL\.md\b/iu.exec(
    skillResultText,
  )?.[1];
  if (relativePath === undefined || relativePath.startsWith("/")) {
    return null;
  }

  const systemText = prompt
    .filter((message) => message.role === "system")
    .map((message) => getPromptContentText(message.content))
    .join("\n");
  const advertisedPath = new RegExp(
    `-\\s+${escapeRegExp(skillId)}\\s*:[^\\n]*\\(path:\\s*([^\\n)]+\\/SKILL\\.md)\\)`,
    "iu",
  ).exec(systemText)?.[1];
  if (advertisedPath === undefined) {
    return null;
  }

  return `${advertisedPath.slice(0, -"/SKILL.md".length)}/${relativePath}`;
}

/** Resolves an explicit direct delegation onto one available runtime-agent tool. */
export function resolveMockSubagentDelegation(
  tools: readonly AvailableBootstrapTool[],
  message: string,
): MockSubagentDelegation | null {
  const legacyDirective = LEGACY_SUBAGENT_DIRECTIVE.exec(message);
  const tool =
    legacyDirective?.[1] === undefined
      ? findExplicitSubagentTool(tools, message)
      : tools.find((entry) => entry.name === AGENT_TOOL_NAME);

  if (tool === undefined) {
    return null;
  }

  return {
    message: legacyDirective?.[1]?.trim() ?? extractDelegatedMessage(message) ?? message,
    tool,
  };
}

/** Builds the deterministic JavaScript program requested by a Workflow fan-out prompt. */
export function resolveMockWorkflowFanOutProgram(message: string): string | null {
  if (!WORKFLOW_FAN_OUT_DIRECTIVE.test(message)) {
    return null;
  }

  const subagentName = /\bfan\s+out\b[\s\S]*?\b([A-Za-z0-9_-]+)\s+subagent\s+calls\b/iu.exec(
    message,
  )?.[1];
  const messages = [...message.matchAll(/'([^']+)'/gu)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );

  if (subagentName === undefined || messages.length < 2) {
    return null;
  }

  return [
    `const messages = ${JSON.stringify(messages)};`,
    "const results = await Promise.all(",
    `  messages.map((message) => tools[${JSON.stringify(subagentName)}]({ message })),`,
    ");",
    "return results;",
  ].join("\n");
}

/** Parses a same-tool parallel fan-out directive and its explicit Bash commands. */
export function resolveMockRepeatedToolCallDirective(
  tools: readonly AvailableBootstrapTool[],
  message: string,
): MockRepeatedToolCallDirective | null {
  for (const tool of tools) {
    const directive = new RegExp(
      `\\bcall\\s+(?:the\\s+)?\`?${escapeRegExp(tool.name)}\`?(?:\\s+tool)?\\s+(?:exactly|at\\s+least)\\s+(\\d+|one|two|three|four|five|six|seven|eight|nine|ten)\\s+(?:separate\\s+)?times\\s+in\\s+(?:a|one)\\s+tool-use\\s+step\\b`,
      "iu",
    ).exec(message);
    const count = parseRequestedCount(directive?.[1]);
    if (count === null || count < 2 || count > 64) {
      continue;
    }

    return {
      commands: getToolInputPropertyNames(tool.inputSchema).includes("command")
        ? extractBacktickedCommands(message, tool.name)
        : [],
      count,
      tool,
    };
  }

  return null;
}

/** Chooses the next tool in an explicit sequential/repeated prompt. */
export function findNextMockTool(input: {
  readonly message: string;
  readonly previousToolName: string;
  readonly resultToolNames: readonly string[];
  readonly tools: readonly AvailableBootstrapTool[];
}): AvailableBootstrapTool | null {
  const previousTool = input.tools.find((tool) => tool.name === input.previousToolName);
  const completedPreviousCalls = input.resultToolNames.filter(
    (toolName) => toolName === input.previousToolName,
  ).length;
  const requestedPreviousCalls = resolveRequestedToolCallCount(
    input.message,
    input.previousToolName,
  );

  if (previousTool !== undefined && completedPreviousCalls < requestedPreviousCalls) {
    return previousTool;
  }

  const previousIndex = findToolMentionIndex(input.message, input.previousToolName);
  if (previousIndex < 0) {
    return null;
  }

  return (
    input.tools
      .filter((tool) => tool.name !== input.previousToolName)
      .flatMap((tool) => {
        const index = findToolMentionIndex(input.message, tool.name, previousIndex + 1);
        if (index < 0) {
          return [];
        }

        const transition = input.message.slice(
          previousIndex + input.previousToolName.length,
          index,
        );
        return isSequentialToolTransition(transition) ? [{ index, tool }] : [];
      })
      .sort((left, right) => left.index - right.index)[0]?.tool ?? null
  );
}

/** Detects fixture branches that explicitly forbid calls when a root-only tool is absent. */
export function hasUnavailableConditionalToolBranch(
  tools: readonly AvailableBootstrapTool[],
  message: string,
): boolean {
  if (
    /\bif\s+a\s+Workflow\s+tool\s+is\s+visible\b/iu.test(message) &&
    !tools.some((tool) => tool.name === WORKFLOW_TOOL_NAME)
  ) {
    return true;
  }

  return (
    /\bif\s+a\s+built-in\s+tool\s+named\s+`?agent`?\s+is\s+visible\b/iu.test(message) &&
    !tools.some((tool) => tool.name === AGENT_TOOL_NAME)
  );
}

function findExplicitSubagentTool(
  tools: readonly AvailableBootstrapTool[],
  message: string,
): AvailableBootstrapTool | undefined {
  if (BUILT_IN_SUBAGENT_DIRECTIVE.test(message)) {
    return tools.find((tool) => tool.name === AGENT_TOOL_NAME);
  }

  return tools
    .flatMap((tool) => {
      if (
        tool.name === WORKFLOW_TOOL_NAME ||
        tool.name === LOAD_SKILL_TOOL_NAME ||
        tool.name === FINAL_OUTPUT_TOOL_NAME
      ) {
        return [];
      }

      const name = `\`?${escapeRegExp(tool.name)}\`?`;
      const direct = new RegExp(
        `\\b(?:use|call)\\s+(?:the\\s+)?${name}\\s+(?:subagent|agent)\\b`,
        "iu",
      ).exec(message);
      const delegated = new RegExp(
        `\\bdelegate\\b[\\s\\S]*?\\bto\\s+(?:the\\s+)?${name}\\s+subagent\\b`,
        "iu",
      ).exec(message);
      const index = Math.min(
        direct?.index ?? Number.POSITIVE_INFINITY,
        delegated?.index ?? Number.POSITIVE_INFINITY,
      );

      return Number.isFinite(index) ? [{ index, tool }] : [];
    })
    .sort((left, right) => left.index - right.index)[0]?.tool;
}

function extractDelegatedMessage(message: string): string | null {
  const explicitMessage =
    /\bwith\s+(?:this\s+exact\s+)?message(?:\s+and\s+nothing\s+else(?:\s+\(no outputSchema\))?)?\s*:?\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)/iu.exec(
      message,
    );
  const explicitValue = explicitMessage?.[1] ?? explicitMessage?.[2] ?? explicitMessage?.[3];
  if (explicitValue !== undefined) {
    return explicitValue.trim();
  }

  const childTask =
    /\bgive\s+the\s+child\s+this\s+task:\s*([\s\S]+?)(?=\s+after\s+the\s+child\s+returns\b|$)/iu.exec(
      message,
    )?.[1];

  return childTask?.trim() ?? null;
}

function getLatestSkillResultText(prompt: BootstrapPrompt): string {
  const lastUserIndex = prompt.findLastIndex((message) => message.role === "user");
  for (const message of prompt.slice(lastUserIndex + 1).reverse()) {
    if (message.role !== "tool" && message.role !== "assistant") {
      continue;
    }

    for (const part of [...message.content].reverse()) {
      if (
        typeof part === "string" ||
        part.type !== "tool-result" ||
        part.toolName !== LOAD_SKILL_TOOL_NAME ||
        part.output.type === "execution-denied"
      ) {
        continue;
      }

      return typeof part.output.value === "string"
        ? part.output.value
        : JSON.stringify(part.output.value);
    }
  }

  return "";
}

function resolveRequestedToolCallCount(message: string, toolName: string): number {
  const countMatch = new RegExp(
    `\`?${escapeRegExp(toolName)}\`?(?:\\s+tool)?\\s+(?:(?:exactly|at\\s+least)\\s+)?(\\d+|one|two|three|four|five|six|seven|eight|nine|ten)\\s+(?:separate\\s+)?(?:times|calls?)\\b`,
    "iu",
  ).exec(message);
  const count = parseRequestedCount(countMatch?.[1]);
  if (count !== null) {
    return count;
  }

  const toolIndex = findToolMentionIndex(message, toolName);
  if (toolIndex >= 0 && /\bcall\s+it\s+again\b/iu.test(message.slice(toolIndex))) {
    return 2;
  }

  return 1;
}

function parseRequestedCount(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }

  const numeric = Number.parseInt(value, 10);
  if (Number.isFinite(numeric)) {
    return numeric;
  }

  const wordCounts: Readonly<Record<string, number>> = {
    eight: 8,
    five: 5,
    four: 4,
    nine: 9,
    one: 1,
    seven: 7,
    six: 6,
    ten: 10,
    three: 3,
    two: 2,
  };
  return wordCounts[value.toLowerCase()] ?? null;
}

function isSequentialToolTransition(text: string): boolean {
  return (
    /\bthen\b/iu.test(text) ||
    /\bafter\b[\s\S]*?\b(?:result|returns?)\b/iu.test(text) ||
    /(?:^|\r?\n)\s*\d+\.\s/iu.test(text)
  );
}

function findToolMentionIndex(message: string, toolName: string, fromIndex = 0): number {
  return message.toLowerCase().indexOf(toolName.toLowerCase(), fromIndex);
}

function extractBacktickedCommands(message: string, toolName: string): string[] {
  return [...message.matchAll(/`([^`]+)`/gu)].flatMap((match) => {
    const candidate = match[1]?.trim();
    if (
      candidate === undefined ||
      candidate.length === 0 ||
      normalizeText(candidate) === normalizeText(toolName)
    ) {
      return [];
    }
    return [candidate];
  });
}

function getToolInputPropertyNames(schema: unknown): readonly string[] {
  if (!isRecord(schema) || !isRecord(schema.properties)) {
    return [];
  }

  return Object.keys(schema.properties);
}

function escapeRegExp(value: string): string {
  return value.replace(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`);
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
