import { describe, expect, it, vi } from "vitest";

import { ripgrepIsAvailable } from "#execution/sandbox/ripgrep-probe.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

function createSession(
  id: string,
  results: readonly {
    readonly exitCode: number;
    readonly stderr: string;
    readonly stdout: string;
  }[],
): Pick<SandboxSession, "id" | "run"> {
  const queue = [...results];
  const run: Pick<SandboxSession, "run">["run"] = vi.fn(async () => queue.shift()!);
  return { id, run };
}

describe("ripgrepIsAvailable", () => {
  it("rejects an rg implementation that cannot parse framework flags", async () => {
    const results = [
      { exitCode: 0, stderr: "", stdout: "" },
      { exitCode: 1, stderr: "rg: unrecognized option '--'\n", stdout: "" },
    ];
    const session = createSession("limited-rg", results);

    await expect(ripgrepIsAvailable(session)).resolves.toBe(false);
  });

  it("rejects an rg implementation missing grep capabilities", async () => {
    const results = [
      { exitCode: 0, stderr: "", stdout: "" },
      { exitCode: 1, stderr: "", stdout: "" },
      { exitCode: 1, stderr: "rg: unrecognized option '--context'\n", stdout: "" },
    ];
    const session = createSession("limited-grep-rg", results);

    await expect(ripgrepIsAvailable(session)).resolves.toBe(false);
  });

  it("accepts a capable rg whose probes legitimately find no matches", async () => {
    const results = [
      { exitCode: 0, stderr: "", stdout: "" },
      { exitCode: 1, stderr: "", stdout: "" },
      { exitCode: 1, stderr: "", stdout: "" },
    ];
    const session = createSession("capable-rg", results);

    await expect(ripgrepIsAvailable(session)).resolves.toBe(true);
  });
});
