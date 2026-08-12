import { describe, expect, it } from "vitest";

import {
  EveRolldownBuildProfiler,
  runWithEveRolldownBuildProfiler,
} from "#internal/bundler/build-profile.js";
import {
  createNitroBuildProfilePlugin,
  normalizeNitroProfileModule,
} from "./nitro-build-profile-plugin.js";

const roots = { appRoot: "/workspace/app", packageRoot: "/workspace/eve" };

describe("normalizeNitroProfileModule", () => {
  it.each([
    [
      "/workspace/eve/dist/src/compiled/_chunks/workflow/undici-ABC.js",
      {
        group: "eve:compiled/_chunks/workflow",
        id: "eve:compiled/_chunks/workflow/undici-ABC.js",
      },
    ],
    [
      "/workspace/eve/dist/src/runtime/session.js",
      { group: "eve:runtime", id: "eve:runtime/session.js" },
    ],
    [
      "/workspace/app/.eve/builds/random-id/workflow/workflows.mjs",
      { group: "app:generated", id: "app:generated/workflow/workflows.mjs" },
    ],
    [
      "/workspace/app/agent/tools/weather.ts?transform",
      { group: "app", id: "app:agent/tools/weather.ts" },
    ],
    [
      "/workspace/node_modules/.pnpm/@ai-sdk+gateway@4.0.0/node_modules/@ai-sdk/gateway/dist/index.js",
      { group: "npm:@ai-sdk/gateway", id: "npm:@ai-sdk/gateway/dist/index.js" },
    ],
    ["\0nitro:virtual", { group: "virtual", id: "virtual:nitro:virtual" }],
  ])("normalizes %s", (id, expected) => {
    expect(normalizeNitroProfileModule(id, roots)).toEqual(expected);
  });

  it("retains the active profiler across a later bundler callback", () => {
    const profiler = new EveRolldownBuildProfiler();
    const plugin = runWithEveRolldownBuildProfiler(profiler, () =>
      createNitroBuildProfilePlugin(roots),
    ) as {
      generateBundle(options: unknown, bundle: Readonly<Record<string, unknown>>): void;
    };

    plugin.generateBundle(undefined, {
      "index.mjs": {
        modules: {
          "/workspace/eve/dist/src/runtime/session.js": { renderedLength: 42 },
        },
        type: "chunk",
      },
    });

    expect(profiler.finishNitro()).toMatchObject({
      chunks: 1,
      invocations: 1,
      largestModules: [{ id: "eve:runtime/session.js", renderedLength: 42 }],
      moduleOccurrences: 1,
      renderedLength: 42,
      uniqueModules: 1,
    });
  });
});
