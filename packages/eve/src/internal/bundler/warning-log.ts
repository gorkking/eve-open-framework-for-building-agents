interface RolldownLogLocation {
  readonly file?: unknown;
}

interface RolldownLog {
  readonly id?: unknown;
  readonly ids?: unknown;
  readonly loc?: RolldownLogLocation;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function hasPathSegments(filePath: string, segments: readonly string[]): boolean {
  const pathSegments = normalizePath(filePath).split("/").filter(Boolean);
  return pathSegments.some((_, index) =>
    segments.every((segment, offset) => pathSegments[index + offset] === segment),
  );
}

function isCompiledVendorPath(filePath: string): boolean {
  return (
    hasPathSegments(filePath, [".generated", "compiled"]) ||
    hasPathSegments(filePath, ["dist", "src", "compiled"])
  );
}

function getLogFilePaths(log: string | RolldownLog): readonly string[] {
  if (typeof log === "string") {
    return [];
  }

  const ids = Array.isArray(log.ids) ? log.ids : [];
  return [log.id, ...ids, log.loc?.file].filter(
    (value): value is string => typeof value === "string",
  );
}

/** Keeps warnings from authored code visible while silencing known vendored sources. */
export function createApplicationBundleWarningFilter(): {
  readonly onLog: (
    level: string,
    log: string | RolldownLog,
    defaultHandler: (level: string, log: string | RolldownLog) => void,
  ) => void;
} {
  return {
    onLog(level, log, defaultHandler) {
      const filePaths = getLogFilePaths(log);
      if (level === "warn" && filePaths.length > 0 && filePaths.every(isCompiledVendorPath)) {
        return;
      }

      defaultHandler(level, log);
    },
  };
}
