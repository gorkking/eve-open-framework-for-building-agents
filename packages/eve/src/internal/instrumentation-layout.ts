import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const INSTRUMENTATION_EXTENSIONS = [".ts", ".mts", ".js", ".mjs"] as const;

const INSTRUMENTATION_DIRECTORY = "instrumentation";

const PROVIDERS_FLAG = "experimental.instrumentationProviders";

/**
 * How instrumentation is authored for one agent.
 *
 * `config` is the single `agent/instrumentation.ts` default export. `providers`
 * is a directory of them, one provider per file, keyed by the slot name the
 * file derives (`instrumentation/otel.ts` → `otel`). Which one an agent may use
 * is decided by `experimental.instrumentationProviders`, never by what happens
 * to be on disk.
 */
export type InstrumentationLayout =
  | { readonly kind: "config"; readonly modulePath: string }
  | { readonly kind: "providers"; readonly modulePathsBySlot: Readonly<Record<string, string>> };

/**
 * Resolves the instrumentation layout for one agent root.
 *
 * Returns `undefined` when the agent authored no instrumentation. Throws when
 * the layout on disk is not the one the flag selects: the wrong layout would
 * otherwise be skipped silently, and telemetry that quietly does nothing is the
 * failure this whole surface exists to prevent.
 */
export function resolveInstrumentationLayout(input: {
  readonly agentRoot: string;
  readonly providersEnabled: boolean;
}): InstrumentationLayout | undefined {
  const configPath = resolveInstrumentationConfigModule(input.agentRoot);
  const directoryPath = join(input.agentRoot, INSTRUMENTATION_DIRECTORY);
  const hasDirectory = existsSync(directoryPath) && statSync(directoryPath).isDirectory();

  if (!input.providersEnabled) {
    if (hasDirectory) {
      throw new Error(
        `Found an "${INSTRUMENTATION_DIRECTORY}/" directory at "${input.agentRoot}", but instrumentation providers are off. Set \`${PROVIDERS_FLAG}: true\` in \`defineAgent\`, or move these files back into a single "${INSTRUMENTATION_DIRECTORY}.ts".`,
      );
    }

    return configPath === undefined ? undefined : { kind: "config", modulePath: configPath };
  }

  if (configPath !== undefined) {
    throw new Error(
      `Found "${configPath}", but \`${PROVIDERS_FLAG}\` is on. Move it into the "${INSTRUMENTATION_DIRECTORY}/" directory as one file per provider.`,
    );
  }

  if (!hasDirectory) {
    return undefined;
  }

  return {
    kind: "providers",
    modulePathsBySlot: collectInstrumentationProviderModules(directoryPath),
  };
}

/**
 * Maps each `instrumentation/<slot>.<ext>` file to its absolute path.
 *
 * Slots are sorted so the registration order a provider sees does not depend on
 * how the filesystem happens to enumerate the directory.
 */
function collectInstrumentationProviderModules(
  directoryPath: string,
): Readonly<Record<string, string>> {
  const modulePathsBySlot = new Map<string, string>();

  for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
    if (!entry.isFile()) continue;

    const extension = INSTRUMENTATION_EXTENSIONS.find((candidate) =>
      entry.name.endsWith(candidate),
    );
    if (extension === undefined) continue;

    const slot = entry.name.slice(0, -extension.length);
    if (slot === "") continue;

    const existing = modulePathsBySlot.get(slot);
    if (existing !== undefined) {
      throw new Error(
        `Two files declare the "${slot}" instrumentation provider in "${directoryPath}". Keep one of them.`,
      );
    }

    modulePathsBySlot.set(slot, join(directoryPath, entry.name));
  }

  return Object.fromEntries(
    [...modulePathsBySlot].sort(([left], [right]) => left.localeCompare(right)),
  );
}

/**
 * Resolves the single `agent/instrumentation` module, ignoring any directory of
 * the same name.
 */
function resolveInstrumentationConfigModule(agentRoot: string): string | undefined {
  for (const extension of INSTRUMENTATION_EXTENSIONS) {
    const candidate = join(agentRoot, `${INSTRUMENTATION_DIRECTORY}${extension}`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}
