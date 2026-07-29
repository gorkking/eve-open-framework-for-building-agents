import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getInstrumentationRuntime } from "#harness/instrumentation-runtime.js";
import { DEVELOPMENT_WORKER_APP_ROOT_ENV } from "#internal/workflow/development-world-protocol.js";

let appRoot: string | undefined;

afterEach(async () => {
  delete process.env[DEVELOPMENT_WORKER_APP_ROOT_ENV];
  if (appRoot !== undefined) await rm(appRoot, { force: true, recursive: true });
});

describe("local tracing runtime plugin", () => {
  // The barrier that lets eve run after an authored `instrumentation.ts` whose
  // `setup` is async. Nitro imports every plugin as a static sibling, so a
  // module body cannot wait on one suspended at a top-level await; plugin bodies
  // run only once the whole graph has settled. Installing from module scope
  // would put eve's provider in ahead of the authored one.
  it("installs the runtime from the plugin body, not on import", async () => {
    appRoot = await mkdtemp(join(tmpdir(), "eve-local-tracing-plugin-"));
    process.env[DEVELOPMENT_WORKER_APP_ROOT_ENV] = appRoot;

    const { default: installLocalTracingRuntimePlugin } =
      await import("#internal/nitro/host/local-tracing-runtime-plugin.js");
    expect(getInstrumentationRuntime()).toBeUndefined();

    installLocalTracingRuntimePlugin();

    expect(getInstrumentationRuntime()).toBeDefined();
  });
});
