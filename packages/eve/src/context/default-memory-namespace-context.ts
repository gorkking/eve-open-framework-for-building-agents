import { loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";

export interface DefaultMemoryNamespaceContext {
  readonly appRoot: string;
  readonly nodeId: string;
  readonly slot: string;
}

const DefaultMemoryNamespaceKey = new ContextKey<DefaultMemoryNamespaceContext>(
  "eve.defaultMemoryNamespace",
);

export async function runWithDefaultMemoryNamespaceContext<T>(
  context: DefaultMemoryNamespaceContext,
  callback: () => T | Promise<T>,
): Promise<T> {
  const activeContext = loadContext();
  const previous = activeContext.get(DefaultMemoryNamespaceKey);
  activeContext.setVirtualContext(DefaultMemoryNamespaceKey, context);
  try {
    return await callback();
  } finally {
    activeContext.delete(DefaultMemoryNamespaceKey);
    if (previous !== undefined) {
      activeContext.setVirtualContext(DefaultMemoryNamespaceKey, previous);
    }
  }
}

export function loadDefaultMemoryNamespaceContext(): DefaultMemoryNamespaceContext {
  let context: DefaultMemoryNamespaceContext | undefined;
  try {
    context = loadContext().get(DefaultMemoryNamespaceKey);
  } catch {
    context = undefined;
  }
  if (context === undefined) {
    throw new Error(
      "No active memory namespace context. Call defaultNamespace only as a defineMemory namespace resolver.",
    );
  }
  return context;
}
