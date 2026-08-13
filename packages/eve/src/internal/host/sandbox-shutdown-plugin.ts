import { shutdownActiveSandboxHandles } from "#execution/sandbox/active-handles.js";
import { isEveDevEnvironment } from "#internal/application/optional-package-install.js";
import type { ApplicationLifecycle } from "#internal/host/application-lifecycle.js";

/**
 * Bounds sandbox shutdown so a wedged provider cannot keep the server
 * process alive past the supervisor's kill grace (`eve start` waits
 * 20s before SIGKILL).
 */
const SANDBOX_SHUTDOWN_TIMEOUT_MS = 15_000;

let installed = false;

/**
 * Reports whether this server process owns sandbox shutdown.
 *
 * - `eve dev` workers are excluded: the dev CLI parent already stops
 *   dev-tagged sandboxes when the dev server closes.
 * - Vercel serverless instances are excluded: instance recycling is not
 *   a server stop, and persistent session sandboxes must keep serving
 *   later invocations.
 */
export function shouldInstallSandboxShutdown(env: Record<string, string | undefined>): boolean {
  if (isEveDevEnvironment()) {
    return false;
  }
  if (env.EVE_DEVELOPMENT_SANDBOX_RUN_ID !== undefined) {
    return false;
  }
  if (env.VERCEL !== undefined) {
    return false;
  }
  return true;
}

/**
 * Stops all tracked sandboxes, bounded by
 * {@link SANDBOX_SHUTDOWN_TIMEOUT_MS}. Never throws.
 */
export async function runSandboxShutdown(log: (message: string) => void): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      log("eve: sandbox shutdown timed out; continuing exit");
      resolve();
    }, SANDBOX_SHUTDOWN_TIMEOUT_MS);
    timer.unref?.();
  });

  try {
    await Promise.race([shutdownActiveSandboxHandles({ log }), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Registers sandbox cleanup with the eve application lifecycle. Signal
 * ownership belongs to the Node host, which closes this lifecycle.
 */
export function installSandboxShutdownLifecycle(input: {
  readonly environment: Record<string, string | undefined>;
  readonly lifecycle?: Pick<ApplicationLifecycle, "onClose">;
  readonly log: (message: string) => void;
}): void {
  if (!shouldInstallSandboxShutdown(input.environment)) {
    return;
  }

  input.lifecycle?.onClose(async () => {
    await runSandboxShutdown(input.log);
  });
}

export default function sandboxShutdownPlugin(
  lifecycle?: Pick<ApplicationLifecycle, "onClose">,
): void {
  if (installed) {
    return;
  }
  installed = true;
  installSandboxShutdownLifecycle({
    environment: process.env,
    lifecycle,
    log: (message) => console.error(message),
  });
}
