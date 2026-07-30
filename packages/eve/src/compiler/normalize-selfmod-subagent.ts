import type { LocalSubagentSourceRef } from "#discover/manifest.js";
import {
  type CompiledAgentDefinition,
  type CompiledSubagentNode,
  createCompiledAgentNodeManifest,
  createCompiledSubagentNodeId,
  ROOT_COMPILED_AGENT_NODE_ID,
} from "#compiler/manifest.js";
import { normalizeAuthoredModelReference } from "#compiler/normalize-agent-config.js";
import type { CompileTarget } from "#compiler/target.js";
import type { ManifestCompileContext } from "#compiler/normalize-helpers.js";
import {
  expectObjectRecord,
  expectOnlyKnownKeys,
  expectString,
} from "#internal/authored-module.js";
import type { AgentReasoningDefinition } from "#shared/agent-definition.js";
import { SELFMOD_SANDBOX_BACKEND_NAME } from "#shared/selfmod-definition.js";

const SELFMOD_DESCRIPTION =
  "Immediately delegate here when the developer asks to change this eve agent or its source. Only this subagent has the live agent tree; do not use the root agent's shell or file tools to inspect or verify source before or after delegation.";
const SELFMOD_INSTRUCTIONS = `You are a development-only source editor for an eve application.

The live authored agent directory is mounted at /workspace. Inspect relevant files before editing them, keep changes minimal, and modify only what the developer requested. Existing files must be read before they are overwritten. You cannot access application files outside the authored agent directory or run host binaries such as git, node, pnpm, or tsc; eve's development watcher validates authored changes and keeps the previous generation active when compilation fails. Return a concise summary of files changed and any validation limitations.`;

interface SelfmodModuleSource {
  readonly logicalPath: string;
  readonly sourceId: string;
}

/** Normalizes a development-only selfmod declaration into a compiled agent node. */
export async function normalizeSelfmodSubagent(input: {
  readonly appRoot: string;
  readonly context: ManifestCompileContext;
  readonly moduleSource: SelfmodModuleSource;
  readonly parentConfig: CompiledAgentDefinition;
  readonly parentNodeId: string;
  readonly source: LocalSubagentSourceRef;
  readonly target: CompileTarget;
  readonly value: unknown;
}): Promise<CompiledSubagentNode | null> {
  if (input.parentNodeId !== ROOT_COMPILED_AGENT_NODE_ID) {
    throw new Error(
      `Self-modifying agent "${input.source.logicalPath}" may only be declared on the root agent.`,
    );
  }
  if (input.target === "hosted") return null;

  const message = `Expected the self-modifying agent export from "${input.source.logicalPath}" to match the public eve shape.`;
  const record = expectObjectRecord(input.value, message);
  expectOnlyKnownKeys(
    record,
    ["description", "development", "instructions", "kind", "model", "reasoning"],
    message,
  );
  if (record.kind !== "selfmod") {
    throw new Error(`${message} Expected "kind" to be "selfmod".`);
  }
  if (record.development !== true) {
    throw new Error(`${message} Expected "development" to be the literal true.`);
  }
  const description =
    record.description === undefined
      ? SELFMOD_DESCRIPTION
      : expectString(record.description, message);
  const instructions =
    record.instructions === undefined ? undefined : expectString(record.instructions, message);
  const model =
    record.model === undefined
      ? input.parentConfig.model
      : await normalizeAuthoredModelReference({
          modelCatalog: input.context.modelCatalog,
          purpose: "the self-modifying agent model",
          value: expectString(record.model, message),
        });
  let reasoning = input.parentConfig.reasoning;
  if (record.reasoning !== undefined) {
    const value = expectString(record.reasoning, message);
    if (
      !["provider-default", "none", "minimal", "low", "medium", "high", "xhigh"].includes(value)
    ) {
      throw new Error(message);
    }
    reasoning = value as AgentReasoningDefinition;
  }

  const nodeId = createCompiledSubagentNodeId(input.parentNodeId, input.source.sourceId);
  const config: CompiledAgentDefinition = {
    compaction: input.parentConfig.compaction,
    limits: input.parentConfig.limits,
    model,
    name: input.source.subagentId,
    reasoning,
  };
  const agent = createCompiledAgentNodeManifest({
    agentRoot: input.source.manifest.agentRoot,
    appRoot: input.appRoot,
    config,
    disabledFrameworkTools: ["ask_question", "load_skill", "todo", "web_fetch", "web_search"],
    instructions: {
      logicalPath: "eve:extensions/selfmod/instructions",
      markdown:
        instructions === undefined
          ? SELFMOD_INSTRUCTIONS
          : `${SELFMOD_INSTRUCTIONS}\n\nAdditional developer instructions:\n${instructions}`,
      name: "instructions",
      sourceId: "eve:selfmod-instructions",
      sourceKind: "module",
    },
    sandbox: {
      backendName: SELFMOD_SANDBOX_BACKEND_NAME,
      description: "Development-only live eve application source tree.",
      logicalPath: input.moduleSource.logicalPath,
      sourceHash: "eve-selfmod-v1",
      sourceId: input.moduleSource.sourceId,
      sourceKind: "module",
    },
  });

  return {
    agent,
    description,
    entryPath: input.source.entryPath,
    logicalPath: input.source.logicalPath,
    name: input.source.subagentId,
    nodeId,
    rootPath: input.source.rootPath,
    sourceId: input.source.sourceId,
    sourceKind: "module",
  };
}
