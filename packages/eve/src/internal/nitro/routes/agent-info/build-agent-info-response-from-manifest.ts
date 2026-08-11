import {
  getAllFrameworkToolNames,
  getFrameworkDynamicToolResolvers,
} from "#runtime/framework-tools/index.js";
import {
  getAllFrameworkChannelNames,
  getFrameworkChannelDefinitions,
} from "#runtime/framework-channels/index.js";
import type { AgentInfoManifestData } from "#internal/nitro/routes/agent-info/load-agent-info-data.js";
import type { ResolvedChannelDefinition } from "#runtime/types.js";
import { LOAD_SKILL_TOOL_NAME } from "#runtime/skills/fragment-context.js";
import { WORKFLOW_TOOL_NAME } from "#shared/workflow-sandbox.js";
import type { ModelRouting } from "#shared/agent-definition.js";
import type {
  AgentInfoFrameworkChannelEntry,
  AgentInfoResponse,
} from "#internal/nitro/routes/agent-info/build-agent-info-response.js";
import {
  buildFrameworkToolInfo,
  getRootDelegationToolNames,
  renderChannel,
  renderDynamicResolver,
  renderSchedule,
  renderSubagent,
  toSource,
} from "#internal/nitro/routes/agent-info/build-agent-info-response.js";
import {
  type GatewayCredentialPresence,
  resolveModelEndpointStatus,
} from "#internal/resolve-model-endpoint-status.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export function buildAgentInfoResponseFromManifest(
  data: AgentInfoManifestData,
  input: {
    readonly mode: AgentInfoResponse["mode"];
    readonly gatewayCredentials: GatewayCredentialPresence;
  },
): AgentInfoResponse {
  const manifest = data.manifest;
  const model = manifest.config.model;
  const routing: ModelRouting = model?.routing ?? { kind: "dynamic" };
  const authoredChannels = manifest.channels.filter((channel) => channel.kind === "channel");
  const disabledFrameworkChannels = manifest.channels
    .filter((channel) => channel.kind === "disabled")
    .map((channel) => channel.name);
  const authoredToolNames = new Set(manifest.tools.map((tool) => tool.name));
  const disabledFrameworkTools = new Set(manifest.disabledFrameworkTools);
  const allFrameworkToolNames = getAllFrameworkToolNames();
  const allFrameworkChannelNames = getAllFrameworkChannelNames();
  const frameworkChannelDefinitions = getFrameworkChannelDefinitions();
  const authoredTools = manifest.tools.map((tool) => ({
    ...toSource(tool),
    description: tool.description,
    hasAuth: false,
    hasCompactionHook: false,
    hasExecute: true,
    hasModelOutputProjection: false,
    hasOutputSchema: tool.outputSchema !== undefined && tool.outputSchema !== null,
    inputSchema: tool.inputSchema,
    name: tool.name,
    origin: "authored" as const,
    outputSchema: tool.outputSchema ?? null,
    replacesFrameworkTool: allFrameworkToolNames.has(tool.name),
    requiresApproval: false,
  }));
  const authoredChannelNames = new Set(authoredChannels.map((channel) => channel.name));
  const disabledFrameworkChannelNames = new Set(disabledFrameworkChannels);
  const activeFrameworkChannels = frameworkChannelDefinitions.filter(
    (channel) =>
      !authoredChannelNames.has(channel.name) && !disabledFrameworkChannelNames.has(channel.name),
  );
  const modelInfo: Mutable<AgentInfoResponse["agent"]["model"]> = {
    contextWindowTokens:
      manifest.config.dynamicModel?.contextWindowTokens ?? model?.contextWindowTokens,
    providerOptions: manifest.config.dynamicModel?.providerOptions ?? model?.providerOptions,
    reasoning: manifest.config.reasoning,
    source: model?.source ? toSource(model.source) : undefined,
    routing,
    endpoint: resolveModelEndpointStatus(routing, input.gatewayCredentials),
  };
  if (model !== undefined) modelInfo.id = model.id;
  const frameworkToolInfo = buildFrameworkToolInfo({
    authoredToolNames,
    delegationToolNames: getRootDelegationToolNames(manifest),
    disabledFrameworkToolNames: disabledFrameworkTools,
  });
  const renderedAuthoredChannels = authoredChannels.map((channel) => ({
    ...toSource(channel),
    adapterKind: channel.adapterKind,
    method: channel.method,
    name: channel.name,
    origin: "authored" as const,
    urlPath: channel.urlPath,
  }));

  return {
    agent: {
      agentRoot: manifest.agentRoot,
      appRoot: manifest.appRoot,
      configSource: manifest.config.source ? toSource(manifest.config.source) : undefined,
      description: manifest.config.description,
      model: modelInfo,
      name: manifest.config.name,
      outputSchema: manifest.config.outputSchema,
    },
    capabilities: {
      devRoutes: input.mode === "development",
    },
    channels: {
      authored: renderedAuthoredChannels,
      available: [
        ...activeFrameworkChannels.map((channel) =>
          renderChannel(channel as ResolvedChannelDefinition, {
            origin: "framework",
          }),
        ),
        ...renderedAuthoredChannels,
      ],
      disabledFramework: disabledFrameworkChannels,
      framework: frameworkChannelDefinitions
        .filter((channel) => allFrameworkChannelNames.has(channel.name))
        .map((channel) => {
          const replacedByAuthoredChannel = authoredChannelNames.has(channel.name);
          const disabledByAuthor = disabledFrameworkChannelNames.has(channel.name);
          const status: AgentInfoFrameworkChannelEntry["status"] = disabledByAuthor
            ? "disabled"
            : replacedByAuthoredChannel
              ? "replaced"
              : "active";

          return {
            ...renderChannel(channel as ResolvedChannelDefinition, {
              origin: "framework",
            }),
            disabledByAuthor,
            replacedByAuthoredChannel,
            status,
          };
        }),
    },
    connections: manifest.connections.map((connection) => ({
      ...toSource(connection),
      connectionName: connection.connectionName,
      description: connection.description,
      hasApproval: false,
      hasAuthorization: connection.vercelConnect !== undefined,
      hasHeaders: false,
      protocol: connection.protocol,
      url: connection.url,
    })),
    diagnostics: {
      discoveryErrors: manifest.diagnosticsSummary.errors,
      discoveryWarnings: manifest.diagnosticsSummary.warnings,
    },
    hooks: manifest.hooks.map((hook) => ({
      ...toSource(hook),
      eventNames: [],
      slug: hook.slug,
    })),
    instructions: {
      dynamic: manifest.dynamicInstructions.map((resolver) =>
        renderDynamicResolver(resolver, { origin: "authored" }),
      ),
      static:
        manifest.instructions === undefined
          ? null
          : {
              ...toSource(manifest.instructions),
              markdown: manifest.instructions.markdown,
              name: manifest.instructions.name,
            },
    },
    kind: "eve-agent-info",
    mode: input.mode,
    sandbox:
      manifest.sandbox === null
        ? null
        : {
            ...toSource(manifest.sandbox),
            description: manifest.sandbox.description,
            hasBootstrap: false,
            hasOnSession: false,
            revalidationKey: manifest.sandbox.revalidationKey,
            sourceHash: manifest.sandbox.sourceHash,
          },
    schedules: data.schedules.map(renderSchedule),
    skills: {
      static: manifest.skills.map((skill) => ({
        ...toSource(skill),
        description: skill.description,
        license: skill.license,
        markdown: skill.markdown,
        metadata: skill.metadata,
        name: skill.name,
      })),
      dynamic: manifest.dynamicSkills.map((resolver) =>
        renderDynamicResolver(resolver, { origin: "authored" }),
      ),
    },
    subagents: {
      local: manifest.subagents.map(renderSubagent),
      total: manifest.subagents.length,
    },
    tools: {
      available: [...frameworkToolInfo.available, ...authoredTools],
      authored: authoredTools,
      disabledFramework: [...manifest.disabledFrameworkTools],
      dynamic: [
        ...getFrameworkDynamicToolResolvers().map((resolver) =>
          renderDynamicResolver(resolver, { origin: "framework" }),
        ),
        ...manifest.dynamicTools.map((resolver) =>
          renderDynamicResolver(resolver, { origin: "authored" }),
        ),
      ],
      framework: frameworkToolInfo.framework,
      reserved: [WORKFLOW_TOOL_NAME, LOAD_SKILL_TOOL_NAME],
    },
    version: 1,
    workflow: {
      enabled: manifest.workflowTool !== undefined,
      toolName: WORKFLOW_TOOL_NAME,
    },
    workspace: {
      resourceRoot: manifest.workspaceResourceRoot,
      rootEntries: [...manifest.workspaceResourceRoot.rootEntries],
    },
  };
}
