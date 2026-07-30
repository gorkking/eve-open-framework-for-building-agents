import type { SandboxSession } from "#public/definitions/sandbox.js";

const probes = new Map<string, Promise<boolean>>();

/** Reports whether `rg` supports eve's search flags, cached by sandbox session. */
export async function ripgrepIsAvailable(
  session: Pick<SandboxSession, "id" | "run">,
): Promise<boolean> {
  const existing = probes.get(session.id);
  if (existing !== undefined) {
    return existing;
  }

  const pending = runProbe(session);
  probes.set(session.id, pending);

  try {
    return await pending;
  } catch {
    // If the probe itself threw, treat rg as unavailable and clear the
    // cache so a later call can retry. A failed probe usually means the
    // sandbox session is in a bad state; letting the next call retry is
    // safer than permanently marking rg as missing.
    probes.delete(session.id);
    return false;
  }
}

async function runProbe(session: Pick<SandboxSession, "id" | "run">): Promise<boolean> {
  const located = await session.run({ command: "command -v rg >/dev/null 2>&1" });
  if (located.exitCode !== 0) return false;

  // just-bash provides `rg` but not every flag used by eve's search tools.
  for (const command of [
    "rg --files --hidden --glob '__eve_capability_probe_no_match__' -- /workspace",
    "rg --line-number --color=never --hidden --ignore-case --fixed-strings --glob '!.git/*' --glob '*.ts' --context 1 --max-count 1 -- '__eve_capability_probe_no_match__' /workspace",
  ]) {
    const capability = await session.run({ command });
    if ((capability.exitCode !== 0 && capability.exitCode !== 1) || capability.stderr.length > 0) {
      return false;
    }
  }
  return true;
}
