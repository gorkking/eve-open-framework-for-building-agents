import type { BootstrapPrompt } from "#runtime/agent/bootstrap-model-utils.js";
import { getPromptContentText } from "#runtime/agent/bootstrap-model-utils.js";
import { createJsonSchemaSample } from "#runtime/agent/mock-structured-output.js";
import { LOAD_SKILL_TOOL_NAME } from "#runtime/skills/fragment-context.js";

export interface AvailableBootstrapTool {
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly name: string;
  readonly outputSchema?: unknown;
}

export function createMockAuthoredToolInput(
  tool: AvailableBootstrapTool,
  message: string,
  city: string,
  occurrence = 0,
): Record<string, unknown> {
  const inputPropertyNames = getToolInputPropertyNames(tool.inputSchema);
  if (tool.name === "ask_question" || hasProperties(inputPropertyNames, ["prompt", "options"])) {
    return createAskQuestionInput(message);
  }

  if (inputPropertyNames.includes("command")) {
    return { command: resolveShellCommand(message, tool.name, occurrence) };
  }

  if (
    inputPropertyNames.includes("topic") ||
    (!hasDeclaredInputProperties(tool.inputSchema) && /\btopic\b/u.test(normalizeText(message)))
  ) {
    return { topic: resolveLookupTopic(message) };
  }

  const derived = {
    ...extractSchemaDerivedInputs(tool.inputSchema, message),
    ...extractAnchoredInputs(inputPropertyNames, message, occurrence),
  };
  if (Object.keys(derived).length > 0) {
    return completeRequiredInputs(tool.inputSchema, derived);
  }

  if (inputPropertyNames.length === 1 && inputPropertyNames[0] === "message") {
    return { message };
  }

  if (inputPropertyNames.includes("city") || !hasDeclaredInputProperties(tool.inputSchema)) {
    return { city };
  }

  const sample = createJsonSchemaSample(tool.inputSchema);
  return isRecord(sample) ? sample : {};
}

/**
 * Extracts tool inputs anchored to schema property names in the message, e.g.
 * `with label "smoke-test"`, ``value `hello```, or `note: 'smoke'`. This lets
 * deterministic smoke evals drive tools whose schemas fall outside the
 * special-cased heuristics above.
 */
function extractAnchoredInputs(
  propertyNames: readonly string[],
  message: string,
  occurrence: number,
): Record<string, string> {
  const inputs: Record<string, string> = {};

  for (const propertyName of propertyNames) {
    const pattern = new RegExp(
      `\\b${escapeRegExp(propertyName)}\\b\\s*(?:to|=|:)?\\s*(?:\`([^\`]+)\`|"([^"]+)"|'([^']+)')`,
      "giu",
    );
    const matches = [...message.matchAll(pattern)];
    const match = matches[occurrence] ?? matches.at(-1);
    const value = match?.[1] ?? match?.[2] ?? match?.[3];

    if (value !== undefined) {
      inputs[propertyName] = value.trim();
    }
  }

  return inputs;
}

function escapeRegExp(value: string): string {
  return value.replace(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`);
}

function extractSchemaDerivedInputs(schema: unknown, message: string): Record<string, unknown> {
  const properties = getToolInputProperties(schema);
  const inputs: Record<string, unknown> = {};

  for (const [propertyName, propertySchema] of Object.entries(properties)) {
    if (isNumericArraySchema(propertySchema)) {
      const values = resolveNumericArray(message, propertyName);
      if (values.length > 0) {
        inputs[propertyName] = values;
      }
    }
  }

  if ("connection" in properties) {
    const connection = /\bin\s+(?:the\s+)?[`"']?([A-Za-z0-9_-]+)[`"']?\s+connection\b/iu.exec(
      message,
    )?.[1];
    if (connection !== undefined) {
      inputs.connection = connection;
    }
  }

  if ("keywords" in properties) {
    const keywords = /\bfind\s+(?:the\s+)?(.+?)\s+(?:operation|tool)\b/iu.exec(message)?.[1];
    if (keywords !== undefined) {
      inputs.keywords = keywords.trim();
    }
  }

  if ("filePath" in properties) {
    const filePath =
      /\b(?:create|write)\s+(?:the\s+)?file\s+(`([^`]+)`|"([^"]+)"|'([^']+)'|(\S+))/iu.exec(
        message,
      );
    const value =
      filePath?.[2] ?? filePath?.[3] ?? filePath?.[4] ?? filePath?.[5]?.replace(/[.,;:]$/u, "");
    if (value !== undefined) {
      inputs.filePath = value;
    }
  }

  if ("content" in properties) {
    const content = /\bcontent:\s*([^\r\n]+)/iu.exec(message)?.[1]?.trim();
    if (content !== undefined) {
      inputs.content = content;
    }
  }

  if ("pattern" in properties) {
    const pattern = /\bsearch\s+for\s+(`([^`]+)`|"([^"]+)"|'([^']+)'|([^\s.,;]+))/iu.exec(message);
    const value = pattern?.[2] ?? pattern?.[3] ?? pattern?.[4] ?? pattern?.[5];
    if (value !== undefined) {
      inputs.pattern = value;
    }
  }

  if ("path" in properties) {
    const path = /\bunder\s+(`([^`]+)`|"([^"]+)"|'([^']+)'|([/][^\s.,;]+))/iu.exec(message);
    const value = path?.[2] ?? path?.[3] ?? path?.[4] ?? path?.[5];
    if (value !== undefined) {
      inputs.path = value;
    }
  }

  return inputs;
}

function completeRequiredInputs(
  schema: unknown,
  inputs: Record<string, unknown>,
): Record<string, unknown> {
  if (!isRecord(schema) || !Array.isArray(schema.required)) {
    return inputs;
  }

  const sample = createJsonSchemaSample(schema);
  if (!isRecord(sample)) {
    return inputs;
  }

  const completed = { ...inputs };
  for (const propertyName of schema.required) {
    if (
      typeof propertyName === "string" &&
      completed[propertyName] === undefined &&
      sample[propertyName] !== undefined
    ) {
      completed[propertyName] = sample[propertyName];
    }
  }

  return completed;
}

function getToolInputProperties(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema) || !isRecord(schema.properties)) {
    return {};
  }

  return schema.properties;
}

function isNumericArraySchema(schema: unknown): boolean {
  return (
    isRecord(schema) &&
    schema.type === "array" &&
    isRecord(schema.items) &&
    (schema.items.type === "integer" || schema.items.type === "number")
  );
}

function resolveNumericArray(message: string, propertyName: string): number[] {
  const marker = new RegExp(
    `\\b(?:${escapeRegExp(propertyName)}|integers?|numbers?)\\b\\s*:?\\s*([^\\r\\n.]+)`,
    "iu",
  ).exec(message)?.[1];
  if (marker === undefined) {
    return [];
  }

  return [...marker.matchAll(/-?\d+(?:\.\d+)?/gu)].map((match) => Number(match[0]));
}

export function resolveMockFixtureToken(prompt: BootstrapPrompt): string | null {
  const systemText = prompt
    .filter((message) => message.role === "system")
    .map((message) => getPromptContentText(message.content))
    .join("\n");
  // The current turn's user batch participates last so instruction- and
  // skill-delivered fixture directives always win. Scanning user text makes
  // per-turn context (clientContext entries, channel context strings) and
  // exact-reply prompts deterministically provable in smoke evals. Only the
  // trailing user messages count: directives from earlier turns must not
  // leak into later replies.
  const searchableTexts = [
    ...getLoadedSkillResultTexts(prompt),
    systemText,
    getTrailingUserText(prompt),
  ];

  for (const text of searchableTexts) {
    const fixtureReply = resolveExactFixtureReply(text);
    if (fixtureReply !== null) return fixtureReply;
  }

  return null;
}

/** Recalls a simple fact stated as `my <label> is <value>` in an earlier turn. */
export function resolveMockConversationRecall(prompt: BootstrapPrompt): string | null {
  const lastUserIndex = prompt.findLastIndex((message) => message.role === "user");
  const lastUserMessage = prompt[lastUserIndex];
  if (lastUserMessage === undefined) {
    return null;
  }

  const question = /\bwhat\s+is\s+my\s+([^?]+)\?/iu.exec(
    getPromptContentText(lastUserMessage.content),
  )?.[1];
  if (question === undefined) {
    return null;
  }

  const factPattern = new RegExp(
    `\\bmy\\s+${escapeRegExp(question.trim())}\\s+is\\s+([A-Za-z0-9_-]+)\\b`,
    "iu",
  );
  for (const message of prompt.slice(0, lastUserIndex).reverse()) {
    if (message.role !== "user") {
      continue;
    }

    const value = factPattern.exec(getPromptContentText(message.content))?.[1];
    if (value !== undefined) {
      return value;
    }
  }

  return null;
}

export function resolveWeatherCity(message: string): string {
  const invocationJsonCityMatch = /"city"\s*:\s*"([^"]+)"/u.exec(message);

  if (invocationJsonCityMatch?.[1]) {
    return invocationJsonCityMatch[1].trim();
  }

  const cityMatch =
    /\b(?:in|for)\s+([A-Za-z][A-Za-z\s.-]*?)(?:[?.!,]|$)/u.exec(message) ??
    /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/u.exec(message);

  return cityMatch?.[1]?.trim() || "Brooklyn";
}

export function formatToolOutput(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }

  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

/** Joined text of the user messages at the tail of the prompt (the current turn's batch). */
function getTrailingUserText(prompt: BootstrapPrompt): string {
  const texts: string[] = [];

  for (const message of [...prompt].reverse()) {
    if (message.role === "system") continue;
    if (message.role !== "user") break;
    texts.unshift(getPromptContentText(message.content));
  }

  return texts.join("\n");
}

function getLoadedSkillResultTexts(prompt: BootstrapPrompt): string[] {
  return prompt.flatMap((message) => {
    if (message.role !== "tool" && message.role !== "assistant") {
      return [];
    }

    const parts = typeof message.content === "string" ? [message.content] : message.content;

    return parts.flatMap((part) => {
      if (typeof part === "string" || part.type !== "tool-result") {
        return [];
      }

      if (part.toolName !== LOAD_SKILL_TOOL_NAME || part.output.type === "execution-denied") {
        return [];
      }

      return [formatToolOutput(part.output.value)];
    });
  });
}

function resolveExactFixtureReply(text: string): string | null {
  const exactString = matchExactValue(
    /\breply\s+with\s+the\s+exact\s+string\s+(`([^`]+)`|"([^"]+)"|'([^']+)'|([^\s.]+))\s+and\s+nothing\s+else\b/iu,
    text,
  );
  if (exactString !== null) {
    return exactString;
  }

  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    const inlineBlockMatch =
      /\breply\s+with\s+exactly(?:\s+the\s+following\s+text\s+and\s+nothing\s+else)?:\s*(.+)$/iu.exec(
        line,
      );
    if (inlineBlockMatch?.[1]) {
      return cleanExactValue(inlineBlockMatch[1]);
    }

    if (
      /\breply\s+with\s+exactly\s+the\s+following\s+text\s+and\s+nothing\s+else:\s*$/iu.test(
        line,
      ) ||
      /\breply\s+with\s+exactly:\s*$/iu.test(line)
    ) {
      const nextLine = lines
        .slice(index + 1)
        .map((candidate) => candidate.trim())
        .find((candidate) => candidate.length > 0);
      if (nextLine !== undefined) {
        return cleanExactValue(nextLine);
      }
    }
  }

  const exactReturn = matchExactValue(
    /\breturn\s+exactly\s+(`([^`]+)`|"([^"]+)"|'([^']+)'|([A-Za-z0-9_=.-]+))/iu,
    text,
  );
  if (exactReturn !== null) {
    return exactReturn;
  }

  return matchExactValue(
    /\binclude\s+the\s+exact\s+token\s+(`([^`]+)`|"([^"]+)"|'([^']+)'|([^\s.]+))\s+verbatim\b/iu,
    text,
  );
}

function matchExactValue(pattern: RegExp, text: string): string | null {
  const match = pattern.exec(text);
  if (match === null) return null;

  return cleanExactValue(match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[1] ?? "");
}

function cleanExactValue(value: string): string {
  return value.trim();
}

function getToolInputPropertyNames(schema: unknown): readonly string[] {
  if (!isRecord(schema) || !isRecord(schema.properties)) {
    return [];
  }

  return Object.keys(schema.properties);
}

function hasDeclaredInputProperties(schema: unknown): boolean {
  return isRecord(schema) && isRecord(schema.properties);
}

function hasProperties(actual: readonly string[], expected: readonly string[]): boolean {
  return expected.every((property) => actual.includes(property));
}

function createAskQuestionInput(message: string): Record<string, unknown> {
  const options = parseInputOptions(message);
  const input: Record<string, unknown> = {
    prompt: resolveQuestionPrompt(message),
  };

  if (options.length > 0) {
    input.options = options;
  }

  if (/\ballow\s*freeform\s+(?:to\s+)?true\b|\ballowfreeform\s+(?:to\s+)?true\b/iu.test(message)) {
    input.allowFreeform = true;
  }

  return input;
}

function parseInputOptions(message: string): Array<{ id: string; label: string }> {
  return [...message.matchAll(/\bid\b\s*:?\s*"([^"]+)"\s*,\s*label\b\s*:?\s*"([^"]+)"/giu)].map(
    (match) => ({
      id: match[1] ?? "",
      label: match[2] ?? "",
    }),
  );
}

function resolveQuestionPrompt(message: string): string {
  const quotedPrompt =
    /\b(?:set\s+)?prompt\s+to:\s*'([^']+)'/iu.exec(message) ??
    /\b(?:set\s+)?prompt\s+to:\s*"([^"]+)"/iu.exec(message);
  if (quotedPrompt?.[1]) {
    return quotedPrompt[1].trim();
  }

  const askMatch = /\bask(?:\s+me)?\s+(?:to\s+)?(.+?)(?:\.|$)/iu.exec(message);
  return askMatch?.[1]?.trim() || "Please choose an option.";
}

function resolveShellCommand(message: string, toolName: string, occurrence: number): string {
  const backtickCommands = [...message.matchAll(/`([^`]+)`/gu)]
    .map((match) => match[1]?.trim())
    .filter(
      (candidate): candidate is string =>
        candidate !== undefined &&
        candidate.length > 0 &&
        normalizeText(candidate) !== normalizeText(toolName),
    );
  const backtickCommand = backtickCommands[occurrence] ?? backtickCommands.at(-1);
  if (backtickCommand !== undefined) {
    return backtickCommand;
  }

  const quotedCommand =
    /\b(?:run|command)\s+["']([^"']+)["']/iu.exec(message) ??
    /\bcommand\s+(.+?)(?:\.|$)/iu.exec(message);

  return quotedCommand?.[1]?.trim() || "pwd";
}

function resolveLookupTopic(message: string): string {
  const topicMatch = /\btopic\s+['"]?([A-Za-z0-9_.-]+)['"]?/u.exec(message);
  return topicMatch?.[1] ?? "demo";
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
