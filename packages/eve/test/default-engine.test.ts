import { describe, expect, it } from "vitest";
import {
  createDefaultSandboxEngine,
  selectDefaultSandboxEngine,
  type DefaultSandboxProbes,
} from "../src/execution/sandbox/default-engine.js";

function probes(overrides: Partial<DefaultSandboxProbes>): DefaultSandboxProbes {
  return {
    isDeployedOnVercel: () => false,
    isDockerAvailable: () => false,
    isMicrosandboxSupported: () => false,
    ...overrides,
  };
}

describe("selectDefaultSandboxEngine", () => {
  it("prefers Vercel Sandbox when deploying on Vercel, before any local probe", () => {
    let probed = false;
    const provider = selectDefaultSandboxEngine(
      undefined,
      probes({
        isDeployedOnVercel: () => true,
        isDockerAvailable: () => {
          probed = true;
          return true;
        },
      }),
    );
    expect(provider.provider).toBe("vercel");
    expect(probed).toBe(false);
  });

  it("picks docker when a daemon is available", () => {
    const provider = selectDefaultSandboxEngine(
      undefined,
      probes({ isDockerAvailable: () => true, isMicrosandboxSupported: () => true }),
    );
    expect(provider.provider).toBe("docker");
  });

  it("falls back to microsandbox on supported hosts without docker", () => {
    const provider = selectDefaultSandboxEngine(
      undefined,
      probes({ isMicrosandboxSupported: () => true }),
    );
    expect(provider.provider).toBe("microsandbox");
  });

  it("falls back to just-bash when nothing else is available", () => {
    const provider = selectDefaultSandboxEngine(undefined, probes({}));
    expect(provider.provider).toBe("just-bash");
  });
});

describe("createDefaultSandboxEngine", () => {
  it("constructs a lazy provider without probing at construction time", () => {
    // Constructing must not touch the host: probing happens on first
    // use (name access / create / prewarm) via the lazy wrapper.
    const provider = createDefaultSandboxEngine({ docker: { image: "alpine:3" } });
    expect(typeof provider.create).toBe("function");
    expect(typeof provider.prepare).toBe("function");
  });
});
