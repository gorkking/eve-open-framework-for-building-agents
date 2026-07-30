import { describe, expect, it } from "vitest";
import {
  createDefaultSandboxBackend,
  selectDefaultSandboxBackend,
  type DefaultSandboxProbes,
} from "../src/execution/sandbox/default-backend.js";

function probes(overrides: Partial<DefaultSandboxProbes>): DefaultSandboxProbes {
  return {
    isDeployedOnVercel: () => false,
    isDockerAvailable: () => false,
    isMicrosandboxSupported: () => false,
    ...overrides,
  };
}

describe("selectDefaultSandboxBackend", () => {
  it("prefers Vercel Sandbox when deploying on Vercel, before any local probe", () => {
    let probed = false;
    const backend = selectDefaultSandboxBackend(
      undefined,
      probes({
        isDeployedOnVercel: () => true,
        isDockerAvailable: () => {
          probed = true;
          return true;
        },
      }),
    );
    expect(backend.name).toBe("vercel");
    expect(probed).toBe(false);
  });

  it("picks docker when a daemon is available", () => {
    const backend = selectDefaultSandboxBackend(
      undefined,
      probes({ isDockerAvailable: () => true, isMicrosandboxSupported: () => true }),
    );
    expect(backend.name).toBe("docker");
  });

  it("falls back to microsandbox on supported hosts without docker", () => {
    const backend = selectDefaultSandboxBackend(
      undefined,
      probes({ isMicrosandboxSupported: () => true }),
    );
    expect(backend.name).toBe("microsandbox");
  });

  it("falls back to just-bash when nothing else is available", () => {
    const backend = selectDefaultSandboxBackend(undefined, probes({}));
    expect(backend.name).toBe("just-bash");
  });
});

describe("createDefaultSandboxBackend", () => {
  it("constructs a lazy backend without probing at construction time", () => {
    // Constructing must not touch the host: probing happens on first
    // use (name access / create / prewarm) via the lazy wrapper.
    const backend = createDefaultSandboxBackend({ docker: { image: "alpine:3" } });
    expect(typeof backend.create).toBe("function");
    expect(typeof backend.prewarm).toBe("function");
  });
});
