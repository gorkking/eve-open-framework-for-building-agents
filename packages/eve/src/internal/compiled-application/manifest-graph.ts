import { z } from "#compiled/zod/index.js";

import type { DiscoverDiagnosticsSummary } from "#discover/diagnostics.js";
import {
  type CompiledDynamicSubagentDefinition,
  compiledRemoteAgentNodeSchema,
  type CompiledRemoteAgentNode,
} from "#internal/compiled-application/remote-agent-node.js";
import {
  compiledAgentBuildDefinitionSchema,
  compiledAgentConfigSchema,
  compiledAgentNodeManifestSchema,
  compiledAgentResourceFields,
  compiledAgentResourcesSchema,
  type CompiledAgentDefinition,
  type CompiledAgentNodeManifest,
  type CompiledAgentResources,
  type CompiledChannelEntry,
  type CompiledConnectionDefinition,
  type CompiledDynamicInstructionsDefinition,
  type CompiledDynamicSkillDefinition,
  type CompiledDynamicToolDefinition,
  type CompiledExtensionMount,
  type CompiledHookDefinition,
  type CompiledInstructionsDefinition,
  type CompiledRuntimeModelReference,
  type CompiledSandboxDefinition,
  type CompiledSandboxWorkspace,
  type CompiledScheduleDefinition,
  type CompiledSkillDefinition,
  type CompiledToolDefinition,
  type CompiledWorkflowToolDefinition,
  type CompiledWorkspaceResourceRoot,
} from "#internal/compiled-application/manifest-resources.js";
import type { Node } from "#shared/node.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import type { ModelRouting } from "#shared/agent-definition.js";
import type { WebSearchProvider } from "#shared/web-search.js";

/** Stable manifest kind emitted by the compiler for runtime loading. */
export const COMPILED_AGENT_MANIFEST_KIND = "eve-agent-compiled-manifest";

/** Stable node id used by compiled artifacts for the root authored agent. */
export const ROOT_COMPILED_AGENT_NODE_ID = "__root__";

/** Current compiled manifest schema version. */
export const COMPILED_AGENT_MANIFEST_VERSION = 41;

export type CompiledSubagentNode = Readonly<
  ModuleSourceRef &
    Node & {
      entryPath: string;
      name: string;
      rootPath: string;
    } & (
      | {
          agent: CompiledAgentNodeManifest;
          configResolver?: never;
          description: string;
        }
      | {
          agent: CompiledAgentResources;
          configResolver: CompiledDynamicSubagentDefinition;
          description?: never;
        }
    )
>;

/** Parent-child edge connecting two compiled agent nodes. */
export interface CompiledSubagentEdge {
  readonly childNodeId: string;
  readonly parentNodeId: string;
}

/** Versioned compiled manifest emitted by the compiler and loaded by runtime. */
export type CompiledAgentManifest = z.infer<typeof compiledAgentManifestSchema>;

const compiledSubagentNodeBaseFields = {
  entryPath: z.string(),
  logicalPath: z.string(),
  name: z.string(),
  nodeId: z.string(),
  rootPath: z.string(),
  sourceId: z.string(),
  sourceKind: z.literal("module"),
  exportName: z.string().optional(),
};

const compiledDynamicSubagentDefinitionSchema = z
  .object({
    build: compiledAgentBuildDefinitionSchema.optional(),
    eventNames: z.array(z.string()).readonly(),
    exportName: z.string().optional(),
    logicalPath: z.string(),
    sourceId: z.string(),
    sourceKind: z.literal("module"),
  })
  .strict();

const compiledSubagentNodeSchema: z.ZodType<CompiledSubagentNode> = z.union([
  z
    .object({
      ...compiledSubagentNodeBaseFields,
      agent: compiledAgentNodeManifestSchema,
      description: z.string(),
    })
    .strict(),
  z
    .object({
      ...compiledSubagentNodeBaseFields,
      agent: compiledAgentResourcesSchema,
      configResolver: compiledDynamicSubagentDefinitionSchema,
    })
    .strict(),
]);

const compiledSubagentEdgeSchema: z.ZodType<CompiledSubagentEdge> = z
  .object({
    childNodeId: z.string(),
    parentNodeId: z.string(),
  })
  .strict();

/** Zod schema for the versioned compiled manifest emitted by the compiler. */
export const compiledAgentManifestSchema = z
  .object({
    agentRoot: z.string(),
    appRoot: z.string(),
    extensionMounts: compiledAgentResourceFields.extensionMounts,
    channels: compiledAgentResourceFields.channels,
    config: compiledAgentConfigSchema,
    connections: compiledAgentResourceFields.connections,
    diagnosticsSummary: compiledAgentResourceFields.diagnosticsSummary,
    disabledFrameworkTools: compiledAgentResourceFields.disabledFrameworkTools,
    workflowTool: compiledAgentResourceFields.workflowTool,
    webSearchProvider: compiledAgentResourceFields.webSearchProvider,
    dynamicInstructions: compiledAgentResourceFields.dynamicInstructions,
    dynamicSkills: compiledAgentResourceFields.dynamicSkills,
    dynamicTools: compiledAgentResourceFields.dynamicTools,
    hooks: compiledAgentResourceFields.hooks,
    kind: z.literal(COMPILED_AGENT_MANIFEST_KIND),
    remoteAgents: z.array(compiledRemoteAgentNodeSchema),
    sandbox: compiledAgentResourceFields.sandbox,
    sandboxWorkspaces: compiledAgentResourceFields.sandboxWorkspaces,
    schedules: compiledAgentResourceFields.schedules,
    skills: compiledAgentResourceFields.skills,
    subagentEdges: z.array(compiledSubagentEdgeSchema),
    subagents: z.array(compiledSubagentNodeSchema),
    instructions: compiledAgentResourceFields.instructions,
    tools: compiledAgentResourceFields.tools,
    version: z.literal(COMPILED_AGENT_MANIFEST_VERSION),
    workspaceResourceRoot: compiledAgentResourceFields.workspaceResourceRoot,
  })
  .strict();

export interface CreateCompiledAgentResourcesInput {
  readonly agentRoot: string;
  readonly appRoot: string;
  readonly channels?: readonly CompiledChannelEntry[];
  readonly connections?: readonly CompiledConnectionDefinition[];
  readonly diagnosticsSummary?: DiscoverDiagnosticsSummary;
  readonly disabledFrameworkTools?: readonly string[];
  readonly workflowTool?: CompiledWorkflowToolDefinition;
  readonly webSearchProvider?: WebSearchProvider;
  readonly dynamicInstructions?: readonly CompiledDynamicInstructionsDefinition[];
  readonly dynamicSkills?: readonly CompiledDynamicSkillDefinition[];
  readonly dynamicTools?: readonly CompiledDynamicToolDefinition[];
  readonly extensionMounts?: readonly CompiledExtensionMount[];
  readonly hooks?: readonly CompiledHookDefinition[];
  readonly remoteAgents?: readonly CompiledRemoteAgentNode[];
  readonly sandbox?: CompiledSandboxDefinition | null;
  readonly sandboxWorkspaces?: readonly CompiledSandboxWorkspace[];
  readonly schedules?: readonly CompiledScheduleDefinition[];
  readonly skills?: readonly CompiledSkillDefinition[];
  readonly instructions?: readonly CompiledInstructionsDefinition[];
  readonly tools?: readonly CompiledToolDefinition[];
  readonly workspaceResourceRoot?: CompiledWorkspaceResourceRoot;
}

/** Creates compiled filesystem-owned resources with stable defaults. */
export function createCompiledAgentResources(
  input: CreateCompiledAgentResourcesInput,
): CompiledAgentResources {
  const resources: CompiledAgentResources = {
    agentRoot: input.agentRoot,
    appRoot: input.appRoot,
    channels: [...(input.channels ?? [])],
    connections: [...(input.connections ?? [])],
    diagnosticsSummary: input.diagnosticsSummary ?? {
      errors: 0,
      warnings: 0,
    },
    disabledFrameworkTools: [...(input.disabledFrameworkTools ?? [])],
    workflowTool:
      input.workflowTool === undefined
        ? undefined
        : { maxSubagents: input.workflowTool.maxSubagents },
    webSearchProvider: input.webSearchProvider,
    dynamicInstructions: [...(input.dynamicInstructions ?? [])],
    dynamicSkills: [...(input.dynamicSkills ?? [])],
    dynamicTools: [...(input.dynamicTools ?? [])],
    extensionMounts: [...(input.extensionMounts ?? [])],
    hooks: [...(input.hooks ?? [])],
    instructions: [...(input.instructions ?? [])],
    remoteAgents: [...(input.remoteAgents ?? [])],
    sandbox: input.sandbox ?? null,
    sandboxWorkspaces: [...(input.sandboxWorkspaces ?? [])],
    schedules: [...(input.schedules ?? [])],
    skills: [...(input.skills ?? [])],
    tools: [...(input.tools ?? [])],
    workspaceResourceRoot: input.workspaceResourceRoot ?? {
      logicalPath: "",
      rootEntries: deriveResourceRootEntries({
        sandboxWorkspaces: input.sandboxWorkspaces,
        skills: input.skills,
      }),
    },
  };

  return resources;
}

/** Creates a compiled authored agent payload with stable defaults. */
export function createCompiledAgentNodeManifest(
  input: CreateCompiledAgentResourcesInput & { readonly config: CompiledAgentDefinition },
): CompiledAgentNodeManifest {
  return {
    ...createCompiledAgentResources(input),
    config: cloneCompiledAgentDefinition(input.config),
  };
}

function cloneCompiledAgentDefinition(config: CompiledAgentDefinition): CompiledAgentDefinition {
  const base = {
    build:
      config.build === undefined
        ? undefined
        : {
            externalDependencies:
              config.build.externalDependencies === undefined
                ? undefined
                : [...config.build.externalDependencies],
          },
    compaction: {
      model:
        config.compaction?.model === undefined
          ? undefined
          : cloneCompiledRuntimeModelReference(config.compaction.model),
      thresholdPercent: config.compaction?.thresholdPercent,
    },
    description: config.description,
    experimental:
      config.experimental === undefined
        ? undefined
        : {
            instrumentationProviders: config.experimental.instrumentationProviders,
            subagentPersistentSessions: config.experimental.subagentPersistentSessions,
            tasks: config.experimental.tasks,
            workflow:
              config.experimental.workflow === undefined
                ? undefined
                : {
                    world: config.experimental.workflow.world,
                  },
          },
    name: config.name,
    outputSchema: config.outputSchema,
    reasoning: config.reasoning,
    limits:
      config.limits === undefined
        ? undefined
        : {
            maxInputTokensPerSession: config.limits.maxInputTokensPerSession,
            maxOutputTokensPerSession: config.limits.maxOutputTokensPerSession,
            sessionTimeoutMs: config.limits.sessionTimeoutMs,
          },
    source:
      config.source === undefined
        ? undefined
        : {
            ...config.source,
          },
  };

  if (config.dynamicModel !== undefined) {
    return {
      ...base,
      dynamicModel: { ...config.dynamicModel },
    };
  }

  return {
    ...base,
    model: cloneCompiledRuntimeModelReference(config.model),
  };
}

/** Computes the sorted entries advertised by a graph node's resource tree. */
export function deriveResourceRootEntries(input: {
  readonly sandboxWorkspaces?: readonly CompiledSandboxWorkspace[];
  readonly skills?: readonly CompiledSkillDefinition[];
}): readonly string[] {
  const rootEntries = new Set<string>();

  for (const workspace of input.sandboxWorkspaces ?? []) {
    for (const entry of workspace.rootEntries) {
      rootEntries.add(entry);
    }
  }

  return [...rootEntries].sort((left, right) => left.localeCompare(right));
}

/** Creates a stable subagent node id from its parent and source entry. */
export function createCompiledSubagentNodeId(parentNodeId: string, sourceId: string): string {
  if (parentNodeId === ROOT_COMPILED_AGENT_NODE_ID) {
    return sourceId;
  }

  return `${parentNodeId}::${sourceId}`;
}

/** Creates a compiled manifest with stable defaults. */
export function createCompiledAgentManifest(input: {
  readonly agentRoot: string;
  readonly appRoot: string;
  readonly channels?: readonly CompiledChannelEntry[];
  readonly config: CompiledAgentDefinition;
  readonly connections?: readonly CompiledConnectionDefinition[];
  readonly diagnosticsSummary?: DiscoverDiagnosticsSummary;
  readonly disabledFrameworkTools?: readonly string[];
  readonly workflowTool?: CompiledWorkflowToolDefinition;
  readonly webSearchProvider?: WebSearchProvider;
  readonly dynamicSkills?: readonly CompiledDynamicSkillDefinition[];
  readonly dynamicTools?: readonly CompiledDynamicToolDefinition[];
  readonly hooks?: readonly CompiledHookDefinition[];
  readonly remoteAgents?: readonly CompiledRemoteAgentNode[];
  readonly sandbox?: CompiledSandboxDefinition | null;
  readonly sandboxWorkspaces?: readonly CompiledSandboxWorkspace[];
  readonly schedules?: readonly CompiledScheduleDefinition[];
  readonly skills?: readonly CompiledSkillDefinition[];
  readonly subagentEdges?: readonly CompiledSubagentEdge[];
  readonly subagents?: readonly CompiledSubagentNode[];
  readonly instructions?: readonly CompiledInstructionsDefinition[];
  readonly tools?: readonly CompiledToolDefinition[];
  readonly extensionMounts?: readonly CompiledExtensionMount[];
}): CompiledAgentManifest {
  return {
    ...createCompiledAgentNodeManifest(input),
    kind: COMPILED_AGENT_MANIFEST_KIND,
    extensionMounts: [...(input.extensionMounts ?? [])],
    subagentEdges: [...(input.subagentEdges ?? [])],
    subagents: [...(input.subagents ?? [])],
    version: COMPILED_AGENT_MANIFEST_VERSION,
  };
}

function cloneCompiledRuntimeModelReference(
  model: CompiledRuntimeModelReference,
): CompiledRuntimeModelReference {
  const clone: CompiledRuntimeModelReference = {
    id: model.id,
    routing: cloneModelRouting(model.routing),
  };
  if (model.contextWindowTokens !== undefined) {
    clone.contextWindowTokens = model.contextWindowTokens;
  }
  if (model.maxOutputTokens !== undefined) {
    clone.maxOutputTokens = model.maxOutputTokens;
  }
  if (model.providerOptions !== undefined) {
    clone.providerOptions = { ...model.providerOptions };
  }
  if (model.source !== undefined) {
    clone.source = { ...model.source };
  }
  return clone;
}

function cloneModelRouting(routing: ModelRouting): ModelRouting {
  if (routing.kind === "external") {
    return { kind: "external", provider: routing.provider };
  }
  return routing.byok === undefined
    ? { kind: "gateway", target: routing.target }
    : { kind: "gateway", target: routing.target, byok: routing.byok };
}
