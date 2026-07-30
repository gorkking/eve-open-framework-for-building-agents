import { describe, expect, it } from "vitest";

import {
  createDockerSandboxEngine,
  createJustBashSandboxEngine,
  createMicrosandboxSandboxEngine,
  DOCKER_PROVIDER,
  JUST_BASH_PROVIDER,
  MICROSANDBOX_PROVIDER,
} from "#execution/sandbox/bindings/local.js";

describe("local sandbox provider factories", () => {
  it("expose distinct stable provider names", () => {
    // Provider names participate in template/session key derivation and
    // persisted reconnect state, so the engines must never collide.
    expect(createDockerSandboxEngine().provider).toBe(DOCKER_PROVIDER);
    expect(createJustBashSandboxEngine().provider).toBe(JUST_BASH_PROVIDER);
    expect(createMicrosandboxSandboxEngine().provider).toBe(MICROSANDBOX_PROVIDER);
    expect(
      new Set([DOCKER_PROVIDER, JUST_BASH_PROVIDER, MICROSANDBOX_PROVIDER, "vercel"]).size,
    ).toBe(4);
  });

  it("constructing a provider performs no environment probing or installs", () => {
    // Construction must stay side-effect free: probing and installs are
    // deferred to first use so `defineSandbox` evaluation (including at
    // compile time) stays cheap on any host.
    expect(createDockerSandboxEngine({ createOptions: { image: "alpine:3" } }).provider).toBe(
      "docker",
    );
    expect(createMicrosandboxSandboxEngine({ createOptions: { cpus: 2 } }).provider).toBe(
      "microsandbox",
    );
    expect(createJustBashSandboxEngine({ createOptions: { autoInstall: false } }).provider).toBe(
      "just-bash",
    );
  });
});
