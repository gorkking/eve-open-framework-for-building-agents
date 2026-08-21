import { describe, expect, it, vi } from "vitest";

import { createDockerSandboxBackend } from "#execution/sandbox/bindings/docker.js";
import type { DockerCli } from "#execution/sandbox/bindings/docker-cli.js";

describe("Docker sandbox destruction", () => {
  it("stops and removes the session container", async () => {
    const run: DockerCli["run"] = vi.fn(async (args: readonly string[]) => ({
      exitCode: 0,
      stderr: "",
      stdout: args[0] === "container" ? "true\n" : "",
      stdoutBytes: Buffer.alloc(0),
    }));
    const dockerCli: DockerCli = {
      run,
      stream() {
        throw new Error("stream is not used by this test");
      },
    };
    const backend = createDockerSandboxBackend({ dockerCli });
    const handle = await backend.create({
      runtimeContext: { appRoot: "/tmp/eve-app" },
      sessionKey: "session-key",
      templateKey: null,
    });
    vi.mocked(run).mockClear();

    await handle.destroy();

    expect(run).toHaveBeenNthCalledWith(1, ["stop", "-t", "0", "session-key"]);
    expect(run).toHaveBeenNthCalledWith(2, ["rm", "-f", "session-key"]);
  });
});
