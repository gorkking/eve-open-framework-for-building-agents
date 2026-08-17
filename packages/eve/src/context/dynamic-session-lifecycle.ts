import type { ModelMessage } from "ai";

import type { ContextContainer } from "#context/container.js";
import { refreshDynamicSessionSubagentsForRuntimeRevision } from "#context/dynamic-subagent-lifecycle.js";
import { refreshDynamicSessionToolsForRuntimeRevision } from "#context/dynamic-tool-lifecycle.js";
import {
  SessionDynamicSubagentRuntimeRevisionKey,
  SessionDynamicToolRuntimeRevisionKey,
} from "#context/keys.js";
import type { SessionStartedStreamEvent } from "#protocol/message.js";
import { resolveRuntimeCompiledArtifactsVersionedCacheKey } from "#runtime/cache-key.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { ResolvedDynamicSubagentResolver } from "#runtime/subagents/registry.js";
import type { ResolvedDynamicToolResolver } from "#runtime/types.js";

export async function prepareDynamicSessionCapabilities(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly ctx: ContextContainer;
  readonly event: SessionStartedStreamEvent;
  readonly messages: readonly ModelMessage[];
  readonly persistentSubagentSessions: boolean;
  readonly sessionStarted: boolean;
  readonly subagentResolvers: readonly ResolvedDynamicSubagentResolver[];
  readonly toolResolvers: readonly ResolvedDynamicToolResolver[];
}): Promise<void> {
  const deploymentId = process.env.VERCEL_DEPLOYMENT_ID?.trim();
  const runtimeRevision = deploymentId
    ? `deployment:${deploymentId}`
    : await resolveRuntimeCompiledArtifactsVersionedCacheKey(input.compiledArtifactsSource);

  if (!input.sessionStarted) {
    input.ctx.set(SessionDynamicSubagentRuntimeRevisionKey, runtimeRevision);
    input.ctx.set(SessionDynamicToolRuntimeRevisionKey, runtimeRevision);
    return;
  }

  await Promise.all([
    refreshDynamicSessionSubagentsForRuntimeRevision({
      ctx: input.ctx,
      event: input.event,
      messages: input.messages,
      persistentSessions: input.persistentSubagentSessions,
      resolvers: input.subagentResolvers,
      runtimeRevision,
    }),
    refreshDynamicSessionToolsForRuntimeRevision({
      ctx: input.ctx,
      event: input.event,
      messages: input.messages,
      resolvers: input.toolResolvers,
      runtimeRevision,
    }),
  ]);
}
