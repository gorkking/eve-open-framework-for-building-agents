import { getWorld } from "#internal/workflow/runtime.js";
import { resolveRuntimeCompiledArtifactsVersionedCacheKey } from "#runtime/cache-key.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

export async function resolveDynamicRuntimeIdentity(
  source: RuntimeCompiledArtifactsSource,
  hasDynamicTools: boolean,
): Promise<{ deploymentId?: string; revision: string }> {
  const vercelDeploymentId = process.env.VERCEL_DEPLOYMENT_ID?.trim();
  const deploymentId =
    vercelDeploymentId ||
    (source.kind === "disk" ? source.deploymentId : undefined) ||
    (hasDynamicTools ? await (await getWorld()).getDeploymentId() : undefined);

  return {
    deploymentId,
    revision: vercelDeploymentId
      ? `deployment:${vercelDeploymentId}`
      : await resolveRuntimeCompiledArtifactsVersionedCacheKey(source),
  };
}
