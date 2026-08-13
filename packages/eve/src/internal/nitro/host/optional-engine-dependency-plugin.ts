/**
 * Optional sandbox engine packages eve's runtime references through lazy
 * dynamic imports. The same bundler policy also handles the project-local
 * build engine supplied by the caller.
 */
export const OPTIONAL_ENGINE_PACKAGES_BY_BACKEND_NAME: Readonly<Record<string, string>> = {
  "just-bash": "just-bash",
  microsandbox: "microsandbox",
};

interface BundlerPluginShape {
  readonly name: string;
  resolveId?(
    source: string,
    importer: string | undefined,
  ): { external: true; id: string } | null | undefined;
}

/**
 * Creates the bundler plugin that pins unconfigured optional engine
 * packages as plain externals — never inlined and never traced — so a
 * resolvable-but-unrequested install adds nothing to hosted output.
 * The lazy runtime import then fails only at first use, with an
 * actionable install error. Packages whose backend the app configured
 * are excluded here and take Nitro's externalize-and-trace path
 * instead, keeping their hosted output self-contained.
 */
export function createOptionalEngineDependencyPlugin(
  unconfiguredPackages: readonly string[],
): BundlerPluginShape | null {
  if (unconfiguredPackages.length === 0) {
    return null;
  }

  const unconfigured = new Set(unconfiguredPackages);

  return {
    name: "eve-optional-engine-dependency-external",
    resolveId(source) {
      if (!unconfigured.has(source)) {
        return null;
      }

      return { external: true, id: source };
    },
  };
}
