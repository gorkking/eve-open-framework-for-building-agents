import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerOTel } from "@vercel/otel";
import { afterEach, describe, expect, it } from "vitest";

import {
  installGlobalTracerProviderInterception,
  releaseGlobalTracerProviderInterception,
} from "#harness/intercept-global-tracer-provider.js";
import { installLocalInstrumentationRuntime } from "#harness/local-instrumentation-runtime.js";

let appRoot: string | undefined;

afterEach(async () => {
  releaseGlobalTracerProviderInterception();
  if (appRoot !== undefined) await rm(appRoot, { force: true, recursive: true });
});

describe("local instrumentation runtime under an authored sampler", () => {
  // eve used to confirm its own registration by starting a probe span and
  // checking that its processor saw it. An authored sampler is free to drop
  // that span, which made `eve dev` startup depend on a coin flip. Whether the
  // writer installs is now independent of sampling — an `always_off` sampler
  // is the extreme case, and the runtime still has to come up so agent context
  // propagates and the authored exporter keeps working.
  it("installs even when the authored sampler records nothing", async () => {
    appRoot = await mkdtemp(join(tmpdir(), "eve-local-traces-sampling-"));

    expect(installGlobalTracerProviderInterception()).toBe(true);

    registerOTel({ serviceName: "authored-agent", traceSampler: "always_off" });

    const runtime = installLocalInstrumentationRuntime({
      appRoot,
      frameworkVersion: "test",
      serviceName: "test-agent",
    });

    expect(runtime).toBeDefined();
  });
});
