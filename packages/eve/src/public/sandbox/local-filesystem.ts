import { spawn as spawnChildProcess } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";

import { bufferToStream, streamToBuffer } from "#execution/sandbox/stream-utils.js";
import { buildSandboxSession } from "#execution/sandbox/session.js";
import type { JsonObject } from "#shared/json.js";
import { defineSandboxAdapter, type Sandbox } from "#shared/sandbox-value.js";
import type { InternalSandboxSession } from "#shared/sandbox-session.js";

interface LocalFilesystemHandle {
  readonly root: string;
}

interface LocalFilesystemReference extends JsonObject {
  readonly root: string;
}

const adaptLocalFilesystem = defineSandboxAdapter<LocalFilesystemHandle, LocalFilesystemReference>({
  reference(handle) {
    return { root: handle.root };
  },
  restore(reference) {
    return { root: reference.root };
  },
  session(handle) {
    return buildSandboxSession(createLocalFilesystemSession(handle.root));
  },
});

/**
 * Options for opening a host directory as an eve sandbox.
 */
export interface LocalFilesystemSandboxOpenOptions {
  /**
   * Directory exposed as `/workspace`. Relative paths resolve from the
   * application process's current working directory.
   */
  readonly root: string;
}

/**
 * A sandbox backed directly by a directory on the eve host.
 */
export const LocalFilesystemSandbox = {
  /**
   * Opens a host directory as a durable sandbox.
   */
  async open(options: LocalFilesystemSandboxOpenOptions): Promise<Sandbox> {
    const root = resolve(options.root);
    await mkdir(root, { recursive: true });
    return adaptLocalFilesystem({ root });
  },
};

function createLocalFilesystemSession(root: string): InternalSandboxSession {
  const resolvePath = (path: string): string => {
    if (path === "/workspace") {
      return root;
    }
    if (path.startsWith("/workspace/")) {
      return join(root, path.slice("/workspace/".length));
    }
    return isAbsolute(path) ? path : join(root, path);
  };

  return {
    id: root,
    resolvePath,
    async spawn(options) {
      const child = spawnChildProcess("bash", ["-lc", options.command], {
        cwd: resolvePath(options.workingDirectory ?? "."),
        env: {
          ...process.env,
          ...options.env,
        },
        signal: options.abortSignal,
        stdio: ["ignore", "pipe", "pipe"],
      });

      return {
        stderr: Readable.toWeb(child.stderr!) as ReadableStream<Uint8Array>,
        stdout: Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
        async kill() {
          child.kill("SIGKILL");
        },
        async wait() {
          return await waitForChild(child);
        },
      };
    },
    async readFile(options) {
      try {
        return bufferToStream(await readFile(options.path, { signal: options.abortSignal }));
      } catch (error) {
        if (isMissingFileError(error)) {
          return null;
        }
        throw error;
      }
    },
    async removePath(options) {
      await rm(options.path, {
        force: options.force,
        recursive: options.recursive,
      });
    },
    async writeFile(options) {
      await mkdir(dirname(options.path), { recursive: true });
      await writeFile(options.path, await streamToBuffer(options.content), {
        signal: options.abortSignal,
      });
    },
  };
}

async function waitForChild(
  child: ReturnType<typeof spawnChildProcess>,
): Promise<{ readonly exitCode: number }> {
  if (child.exitCode !== null) {
    return { exitCode: child.exitCode };
  }

  return await new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => {
      resolvePromise({
        exitCode: exitCode ?? (signal === null ? 1 : 128),
      });
    });
  });
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
