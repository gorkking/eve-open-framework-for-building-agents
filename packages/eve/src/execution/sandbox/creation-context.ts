import { ContextContainer, contextStorage, loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import type { SandboxBackendTags } from "#shared/sandbox-backend.js";

export interface SandboxRuntimeCreationContext {
  readonly appRoot: string;
  readonly sessionKey: string;
  readonly signal: AbortSignal;
  readonly tags?: SandboxBackendTags;
}

export interface SandboxTemplateBuildContext {
  readonly appRoot: string;
  readonly log?: (message: string) => void;
  readonly templateKey: string;
}

const SandboxRuntimeCreationContextKey = new ContextKey<SandboxRuntimeCreationContext>(
  "eve.sandboxRuntimeCreation",
);
const SandboxTemplateBuildContextKey = new ContextKey<SandboxTemplateBuildContext>(
  "eve.sandboxTemplateBuild",
);

export async function withSandboxRuntimeCreationContext<T>(
  context: SandboxRuntimeCreationContext,
  callback: () => T | Promise<T>,
): Promise<T> {
  const active = contextStorage.getStore();
  if (active === undefined) {
    const ctx = new ContextContainer();
    ctx.setVirtualContext(SandboxRuntimeCreationContextKey, context);
    return await contextStorage.run(ctx, callback);
  }
  const ctx = active;
  ctx.setVirtualContext(SandboxRuntimeCreationContextKey, context);
  return await callback();
}

export function requireSandboxRuntimeCreationContext(): SandboxRuntimeCreationContext {
  return loadContext().require(SandboxRuntimeCreationContextKey);
}

export async function withSandboxTemplateBuildContext<T>(
  context: SandboxTemplateBuildContext,
  callback: () => T | Promise<T>,
): Promise<T> {
  const ctx = new ContextContainer();
  ctx.setVirtualContext(SandboxTemplateBuildContextKey, context);
  return await contextStorage.run(ctx, callback);
}

export function requireSandboxTemplateBuildContext(): SandboxTemplateBuildContext {
  return loadContext().require(SandboxTemplateBuildContextKey);
}
