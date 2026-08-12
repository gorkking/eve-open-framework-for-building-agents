import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import {
  createNitroRolldownBundleRecorder,
  type NitroRolldownModuleMeasurement,
} from "#internal/bundler/build-profile.js";

interface RenderedModule {
  readonly renderedLength: number;
}

interface OutputChunk {
  readonly modules: Readonly<Record<string, RenderedModule>>;
  readonly type: "chunk";
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function relativePathInside(root: string, path: string): string | undefined {
  const candidate = relative(root, path);
  if (
    candidate === "" ||
    candidate === ".." ||
    candidate.startsWith(`..${sep}`) ||
    isAbsolute(candidate)
  ) {
    return undefined;
  }
  return normalizePath(candidate);
}

function readPackageNameAndPath(path: string): { name: string; path: string } | undefined {
  const marker = "/node_modules/";
  const markerIndex = path.lastIndexOf(marker);
  if (markerIndex === -1) return undefined;

  const packagePath = path.slice(markerIndex + marker.length);
  const segments = packagePath.split("/");
  const packageSegments = segments[0]?.startsWith("@")
    ? segments.slice(0, 2)
    : segments.slice(0, 1);
  if (packageSegments.length === 0 || packageSegments.some((segment) => !segment)) return undefined;

  return {
    name: packageSegments.join("/"),
    path: segments.slice(packageSegments.length).join("/"),
  };
}

function readCompiledGroup(path: string): string {
  const segments = path.split("/");
  if (segments[0] === "_chunks") return segments.slice(0, 2).join("/");
  return segments[0]?.startsWith("@") ? segments.slice(0, 2).join("/") : (segments[0] ?? "other");
}

/** Normalizes one Rolldown module ID without retaining machine-specific roots. */
export function normalizeNitroProfileModule(
  id: string,
  input: { readonly appRoot: string; readonly packageRoot: string },
): Omit<NitroRolldownModuleMeasurement, "renderedLength"> {
  if (id.startsWith("\0")) {
    return { group: "virtual", id: `virtual:${id.slice(1)}` };
  }

  const cleanId = normalizePath(id.split("?")[0] ?? id);
  const packageRelative = relativePathInside(resolve(input.packageRoot), cleanId);
  if (packageRelative !== undefined) {
    const compiledPath = packageRelative.startsWith(".generated/compiled/")
      ? packageRelative.slice(".generated/compiled/".length)
      : packageRelative.startsWith("dist/src/compiled/")
        ? packageRelative.slice("dist/src/compiled/".length)
        : packageRelative.startsWith("src/compiled/")
          ? packageRelative.slice("src/compiled/".length)
          : undefined;
    if (compiledPath !== undefined) {
      return {
        group: `eve:compiled/${readCompiledGroup(compiledPath)}`,
        id: `eve:compiled/${compiledPath}`,
      };
    }

    const dependency = readPackageNameAndPath(cleanId);
    if (dependency !== undefined) {
      return {
        group: `npm:${dependency.name}`,
        id: `npm:${dependency.name}${dependency.path ? `/${dependency.path}` : ""}`,
      };
    }

    const sourcePath = packageRelative.startsWith("dist/src/")
      ? packageRelative.slice("dist/src/".length)
      : packageRelative.startsWith("src/")
        ? packageRelative.slice("src/".length)
        : packageRelative;
    return {
      group: `eve:${sourcePath.split("/")[0] ?? "package"}`,
      id: `eve:${sourcePath}`,
    };
  }

  const appRelative = relativePathInside(resolve(input.appRoot), cleanId);
  if (appRelative !== undefined) {
    const generatedPath = appRelative.match(/^\.eve\/builds\/[^/]+\/(.*)$/)?.[1];
    return generatedPath === undefined
      ? { group: "app", id: `app:${appRelative}` }
      : { group: "app:generated", id: `app:generated/${generatedPath}` };
  }

  const dependency = readPackageNameAndPath(cleanId);
  if (dependency !== undefined) {
    return {
      group: `npm:${dependency.name}`,
      id: `npm:${dependency.name}${dependency.path ? `/${dependency.path}` : ""}`,
    };
  }

  return { group: "other", id: `other:${basename(cleanId)}` };
}

/** Captures Nitro's rendered module graph when `eve build --profile` is active. */
export function createNitroBuildProfilePlugin(input: {
  readonly appRoot: string;
  readonly packageRoot: string;
}): object {
  const recordBundle = createNitroRolldownBundleRecorder();

  return {
    name: "eve-nitro-build-profile",
    generateBundle(_options: unknown, bundle: Readonly<Record<string, unknown>>) {
      const chunks = Object.values(bundle).filter(
        (output): output is OutputChunk =>
          typeof output === "object" &&
          output !== null &&
          (output as { type?: unknown }).type === "chunk" &&
          typeof (output as { modules?: unknown }).modules === "object",
      );
      const modules = chunks.flatMap((chunk) =>
        Object.entries(chunk.modules).map(([id, module]) => ({
          ...normalizeNitroProfileModule(id, input),
          renderedLength: module.renderedLength,
        })),
      );
      recordBundle?.(chunks.length, modules);
    },
  };
}
