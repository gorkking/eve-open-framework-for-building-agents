/** Prompts, instructions, and tool arguments. */
const INPUT_CONTENT_ATTRIBUTES: ReadonlySet<string> = new Set([
  "ai.documents",
  "ai.prompt",
  "ai.prompt.messages",
  "ai.prompt.system",
  "ai.prompt.toolChoice",
  "ai.prompt.tools",
  "ai.value",
  "ai.values",
  "gen_ai.input.messages",
  "gen_ai.system_instructions",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.definitions",
]);

/** Responses, reasoning, and tool results. */
const OUTPUT_CONTENT_ATTRIBUTES: ReadonlySet<string> = new Set([
  "ai.embedding",
  "ai.embeddings",
  "ai.ranking",
  "ai.response.files",
  "ai.response.object",
  "ai.response.reasoning",
  "ai.response.text",
  "ai.response.toolCalls",
  "ai.response.tool_calls",
  "ai.response.tool_results",
  "ai.toolCall.args",
  "ai.toolCall.result",
  "gen_ai.output.messages",
  "gen_ai.tool.call.result",
]);

/** What one destination is willing to receive. */
export interface ResolvedContentOptions {
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
}

function isDeclined(key: string, content: ResolvedContentOptions): boolean {
  if (!content.recordInputs && INPUT_CONTENT_ATTRIBUTES.has(key)) return true;
  return !content.recordOutputs && OUTPUT_CONTENT_ATTRIBUTES.has(key);
}

/** Returns a copy without declined content, or undefined when no copy is needed. */
export function withoutDeclinedContent(
  attributes: Readonly<Record<string, unknown>>,
  content: ResolvedContentOptions,
): Record<string, unknown> | undefined {
  const keys = Object.keys(attributes);
  if (!keys.some((key) => isDeclined(key, content))) return undefined;

  const kept: Record<string, unknown> = {};
  for (const key of keys) {
    if (!isDeclined(key, content)) kept[key] = attributes[key];
  }
  return kept;
}
