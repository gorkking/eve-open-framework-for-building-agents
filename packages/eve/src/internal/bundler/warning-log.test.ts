import { describe, expect, it, vi } from "vitest";

import { createApplicationBundleWarningFilter } from "./warning-log.js";

describe("createApplicationBundleWarningFilter", () => {
  it("suppresses warnings owned by compiled vendor code", () => {
    const handler = vi.fn();
    const { onLog } = createApplicationBundleWarningFilter();

    onLog("warn", { id: "/app/node_modules/eve/dist/src/compiled/vendor/index.js" }, handler);
    onLog("warn", { ids: ["/repo/packages/eve/.generated/compiled/chunk.js"] }, handler);

    expect(handler).not.toHaveBeenCalled();
  });

  it("preserves authored warnings and non-warning diagnostics", () => {
    const handler = vi.fn();
    const { onLog } = createApplicationBundleWarningFilter();
    const authoredWarning = { id: "/app/agent/tools/evaluate.ts" };
    const vendorError = { id: "/app/node_modules/eve/dist/src/compiled/vendor/index.js" };

    onLog("warn", authoredWarning, handler);
    onLog("error", vendorError, handler);

    expect(handler).toHaveBeenNthCalledWith(1, "warn", authoredWarning);
    expect(handler).toHaveBeenNthCalledWith(2, "error", vendorError);
  });

  it("preserves cross-module warnings that involve authored code", () => {
    const handler = vi.fn();
    const { onLog } = createApplicationBundleWarningFilter();
    const mixedWarning = {
      id: "/app/agent/tools/evaluate.ts",
      ids: [
        "/app/agent/tools/evaluate.ts",
        "/app/node_modules/eve/dist/src/compiled/vendor/index.js",
      ],
      pluginCode: "/app/node_modules/eve/dist/src/compiled/vendor/index.js",
    };

    onLog("warn", mixedWarning, handler);

    expect(handler).toHaveBeenCalledWith("warn", mixedWarning);
  });
});
