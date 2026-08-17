import { z } from "#compiled/zod/index.js";

import type {
  CompiledAgentNodeManifest,
  CompiledAgentResources,
  CompiledExtensionMount,
} from "#internal/compiled-application/manifest.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";

/** Compiled module ownership for one runtime graph node. */
export type CompiledModuleNodeScope = z.infer<typeof compiledModuleNodeScopeSchema>;

/** Flattened compiled authored module map keyed by stable node ids. */
export type CompiledModuleMap = z.infer<typeof compiledModuleMapSchema>;

const compiledModuleNodeScopeSchema = z
  .object({
    modules: z.record(z.string(), z.object({}).passthrough()),
  })
  .strict();

/** Zod schema for the flattened compiled authored module map. */
export const compiledModuleMapSchema = z
  .object({
    nodes: z.record(z.string(), compiledModuleNodeScopeSchema),
  })
  .strict();

/** Collects every runtime module reference from one compiled agent node. */
export function collectModuleRefsForManifest(
  manifest: CompiledAgentNodeManifest | CompiledAgentResources,
): ModuleSourceRef[] {
  const moduleSourceRefs = new Map<string, ModuleSourceRef>();

  if ("config" in manifest && manifest.config.source !== undefined) {
    moduleSourceRefs.set(manifest.config.source.sourceId, manifest.config.source);
  }

  if ("config" in manifest && manifest.config.model?.source !== undefined) {
    moduleSourceRefs.set(manifest.config.model.source.sourceId, manifest.config.model.source);
  }

  for (const channel of manifest.channels) {
    if (channel.kind === "disabled") continue;
    moduleSourceRefs.set(channel.sourceId, {
      exportName: channel.exportName,
      sourceKind: "module",
      logicalPath: channel.logicalPath,
      sourceId: channel.sourceId,
    });
  }

  for (const connection of manifest.connections) {
    moduleSourceRefs.set(connection.sourceId, {
      exportName: connection.exportName,
      sourceKind: "module",
      logicalPath: connection.logicalPath,
      sourceId: connection.sourceId,
    });
  }

  for (const tool of manifest.tools) {
    moduleSourceRefs.set(tool.sourceId, {
      exportName: tool.exportName,
      sourceKind: "module",
      logicalPath: tool.logicalPath,
      sourceId: tool.sourceId,
    });
  }

  for (const dynamicInstruction of manifest.dynamicInstructions) {
    moduleSourceRefs.set(dynamicInstruction.sourceId, {
      exportName: dynamicInstruction.exportName,
      sourceKind: "module",
      logicalPath: dynamicInstruction.logicalPath,
      sourceId: dynamicInstruction.sourceId,
    });
  }

  for (const dynamicSkill of manifest.dynamicSkills) {
    moduleSourceRefs.set(dynamicSkill.sourceId, {
      exportName: dynamicSkill.exportName,
      sourceKind: "module",
      logicalPath: dynamicSkill.logicalPath,
      sourceId: dynamicSkill.sourceId,
    });
  }

  for (const dynamicTool of manifest.dynamicTools) {
    moduleSourceRefs.set(dynamicTool.sourceId, {
      exportName: dynamicTool.exportName,
      sourceKind: "module",
      logicalPath: dynamicTool.logicalPath,
      sourceId: dynamicTool.sourceId,
    });
  }

  for (const remoteAgent of manifest.remoteAgents) {
    moduleSourceRefs.set(remoteAgent.sourceId, {
      exportName: remoteAgent.exportName,
      sourceKind: "module",
      logicalPath: remoteAgent.logicalPath,
      sourceId: remoteAgent.sourceId,
    });
  }

  for (const hook of manifest.hooks) {
    moduleSourceRefs.set(hook.sourceId, {
      exportName: hook.exportName,
      sourceKind: "module",
      logicalPath: hook.logicalPath,
      sourceId: hook.sourceId,
    });
  }

  for (const schedule of manifest.schedules) {
    if (schedule.sourceKind !== "module" || !schedule.hasRun) continue;
    moduleSourceRefs.set(schedule.sourceId, {
      sourceKind: "module",
      logicalPath: schedule.logicalPath,
      sourceId: schedule.sourceId,
    });
  }

  if (manifest.sandbox !== null) {
    moduleSourceRefs.set(manifest.sandbox.sourceId, {
      exportName: manifest.sandbox.exportName,
      sourceKind: "module",
      logicalPath: manifest.sandbox.logicalPath,
      sourceId: manifest.sandbox.sourceId,
    });
  }

  const extensionMounts = (manifest as { extensionMounts?: readonly CompiledExtensionMount[] })
    .extensionMounts;
  if (extensionMounts !== undefined) {
    for (const mount of extensionMounts) {
      moduleSourceRefs.set(mount.mountSourceId, {
        sourceKind: "module",
        logicalPath: mount.mountLogicalPath,
        sourceId: mount.mountSourceId,
      });
    }
  }

  return [...moduleSourceRefs.values()];
}
