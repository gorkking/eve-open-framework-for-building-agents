import { describe, expect, it } from "vitest";

import { createDevelopmentApplicationArtifactsConfig } from "#internal/host/artifacts-config.js";
import { resolveApplicationCompiledArtifactsSource } from "#internal/host/routes/runtime-artifacts.js";
import { serializeDurableCompiledArtifactsSource } from "#runtime/durable-compiled-artifacts-source.js";

describe("development artifacts durable strategy", () => {
  it("stores logical generation selectors when the parent owns the World", () => {
    const config = createDevelopmentApplicationArtifactsConfig({
      appRoot: "/tmp/eve-test-app",
    });

    const source = resolveApplicationCompiledArtifactsSource(config);
    expect(serializeDurableCompiledArtifactsSource(source)).toEqual({ kind: "development" });
  });

  it("treats an explicitly local World as parent-owned", () => {
    const config = createDevelopmentApplicationArtifactsConfig({
      appRoot: "/tmp/eve-test-app",
      configuredWorld: "local",
    });

    const source = resolveApplicationCompiledArtifactsSource(config);
    expect(serializeDurableCompiledArtifactsSource(source)).toEqual({ kind: "development" });
  });

  it("pins custom-World payloads to their exact snapshot", () => {
    const config = createDevelopmentApplicationArtifactsConfig({
      appRoot: "/tmp/eve-test-app",
      configuredWorld: "@workflow/world-postgres",
    });

    // A custom World's deliveries never install eve's generation context,
    // so the durable payload must be resolvable without it.
    const source = resolveApplicationCompiledArtifactsSource(config);
    const durable = serializeDurableCompiledArtifactsSource(source);
    expect(durable).toBe(source);
  });
});
