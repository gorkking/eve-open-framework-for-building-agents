import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SandboxResourceUnavailableError,
  SandboxTemplateUnavailableError,
} from "#shared/sandbox-engine.js";
import { createVercelSandbox } from "#execution/sandbox/bindings/vercel.js";

// The credential fallback consults the developer's Vercel CLI auth and the
// repo's `.vercel` project link; on a linked, logged-in machine it would
// inject real project credentials into the asserted SDK calls.
vi.mock("#compiled/@vercel/oidc/index.js", () => ({
  getVercelOidcToken: vi.fn(async () => {
    throw new Error("No ambient Vercel OIDC token in unit tests.");
  }),
}));

const IMMUTABLE_VERCEL_IMAGE = `vcr.vercel.com/eve/runtime@sha256:${"a".repeat(64)}`;

function createMockCommandResult() {
  return {
    exitCode: 0,
    stderr: vi.fn().mockResolvedValue(""),
    stdout: vi.fn().mockResolvedValue(""),
  };
}

/*
 * A detached command, as returned by `runCommand({ detached: true })`,
 * is adapted into the `Experimental_SandboxProcess` shape — the adapter
 * drains `logs()` alongside `wait()`. This mock yields no log lines and
 * exits 0 so `spawn` and `run` resolve without real I/O.
 */
function createMockDetachedCommand() {
  return {
    kill: vi.fn().mockResolvedValue(undefined),
    logs() {
      return (async function* () {
        yield* [];
      })();
    },
    wait: vi.fn().mockResolvedValue({ exitCode: 0 }),
  };
}

function createMockSandbox(input: {
  createdAt?: Date;
  name: string;
  snapshotId?: string;
  status?: string;
  tags?: Record<string, string>;
}) {
  const files = new Map<string, Buffer>();
  let tags = input.tags;
  return {
    createdAt: input.createdAt ?? new Date("2026-07-30T12:00:00.000Z"),
    currentSnapshotId: input.snapshotId ?? "",
    delete: vi.fn().mockResolvedValue(undefined),
    fs: {
      rm: vi.fn().mockResolvedValue(undefined),
      unlink: vi.fn().mockResolvedValue(undefined),
    },
    name: input.name,
    readFile: vi.fn(async (file: { path: string }): Promise<object | null> => {
      const content = files.get(file.path);
      return content === undefined ? null : Readable.from([content]);
    }),
    runCommand: vi.fn().mockResolvedValue(createMockCommandResult()),
    snapshot: vi.fn().mockResolvedValue({ snapshotId: `${input.name}-snapshot` }),
    status: input.status ?? "running",
    stop: vi.fn().mockResolvedValue(undefined),
    get tags() {
      return tags;
    },
    update: vi.fn().mockImplementation(async (params: { tags?: Record<string, string> }) => {
      if (params.tags !== undefined) {
        tags = params.tags;
      }
    }),
    writeFiles: vi.fn(
      async (nextFiles: ReadonlyArray<{ readonly content: Uint8Array; readonly path: string }>) => {
        for (const file of nextFiles) {
          files.set(file.path, Buffer.from(file.content));
        }
      },
    ),
  };
}

function createTestVercelSandbox(input: Parameters<typeof createVercelSandbox>[0] = {}) {
  return createVercelSandbox({
    ...input,
    createSandbox: async ({ createOptions, sandboxModule }) =>
      await sandboxModule.Sandbox.create(createOptions),
  });
}

async function createTestVercelSession() {
  const templateSandbox = createMockSandbox({ name: "template" });
  const sessionSandbox = createMockSandbox({ name: "session" });
  const sandboxModule = {
    Sandbox: {
      create: vi.fn().mockResolvedValueOnce(templateSandbox).mockResolvedValueOnce(sessionSandbox),
      get: vi.fn().mockResolvedValue(null),
    },
  };
  const provider = createTestVercelSandbox({
    loadSandboxModule: async () => sandboxModule as never,
  });

  await provider.prepare({
    context: { appRoot: "/tmp/test-app-root" },
    seedFiles: [],
    templateKey: "template-key",
  });
  const handle = await provider.create({
    context: { appRoot: "/tmp/test-app-root" },
    sessionKey: "session-key",
    templateKey: "template-key",
  });

  return { handle, sessionSandbox };
}

async function consumeWebStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const result = await reader.read();
    if (result.done) {
      return Buffer.concat(chunks).toString("utf8");
    }
    chunks.push(result.value);
  }
}

beforeEach(() => {
  vi.stubEnv("VERCEL_OIDC_TOKEN", undefined);
  vi.stubEnv("VERCEL_ORG_ID", undefined);
  vi.stubEnv("VERCEL_PROJECT_ID", undefined);
  vi.stubEnv("VERCEL_TEAM_ID", undefined);
  vi.stubEnv("VERCEL_TOKEN", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createVercelSandbox", () => {
  it("creates fresh Vercel sandboxes through the SDK with the eve image", async () => {
    const templateSandbox = createMockSandbox({ name: "template-key" });
    const fetch = vi.fn();
    const sandboxModule = {
      Sandbox: {
        create: vi.fn().mockResolvedValueOnce(templateSandbox),
        get: vi.fn().mockResolvedValueOnce(null),
      },
    };

    const provider = createVercelSandbox({
      createOptions: {
        fetch,
        networkPolicy: "deny-all",
        ports: [3000],
        projectId: "prj_123",
        teamId: "team_123",
        timeout: 123_000,
        token: "vercel-token",
      } as never,
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.prepare({
      context: { appRoot: "/tmp/test-app-root" },
      seedFiles: [],
      templateKey: "template-key",
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(sandboxModule.Sandbox.create).toHaveBeenCalledTimes(1);
    expect(sandboxModule.Sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        image: "vercel/eve:latest",
        name: "template-key",
        networkPolicy: "allow-all",
        persistent: false,
        ports: [3000],
        projectId: "prj_123",
        teamId: "team_123",
        timeout: 123_000,
        token: "vercel-token",
      }),
    );
    expect(templateSandbox.update).toHaveBeenCalledWith({ networkPolicy: "deny-all" });
  });

  it("forwards double-underscore create fields through Sandbox.create", async () => {
    const templateSandbox = createMockSandbox({ name: "template-key" });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn().mockResolvedValueOnce(templateSandbox),
        get: vi.fn().mockResolvedValueOnce(null),
      },
    };

    const provider = createVercelSandbox({
      createOptions: { __experimentalFlag: "enabled" } as never,
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.prepare({
      context: { appRoot: "/tmp/test-app-root" },
      seedFiles: [],
      templateKey: "template-key",
    });

    expect(sandboxModule.Sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        __experimentalFlag: "enabled",
        image: "vercel/eve:latest",
      }),
    );
  });

  it("passes resolved credentials to Vercel sandbox lookups instead of inferring scope", async () => {
    const existingTemplate = createMockSandbox({
      name: "template-key",
      snapshotId: "template-snapshot",
    });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn(),
        get: vi.fn().mockImplementation(async (options: { token?: string }) => {
          if (options.token !== "vercel-token") {
            throw new Error('[{"path":["teams",1,"updatedAt"],"message":"Required"}]');
          }
          return existingTemplate;
        }),
      },
    };

    const provider = createTestVercelSandbox({
      createOptions: {
        image: IMMUTABLE_VERCEL_IMAGE,
        projectId: "prj_123",
        teamId: "team_123",
        token: "vercel-token",
      } as never,
      loadSandboxModule: async () => sandboxModule as never,
    });

    await expect(
      provider.prepare({
        context: { appRoot: "/tmp/test-app-root" },
        seedFiles: [],
        templateKey: "template-key",
      }),
    ).resolves.toMatchObject({
      reused: true,
      reference: {
        sandboxName: "template-key",
        snapshotId: "template-snapshot",
        templateKey: "template-key",
      },
    });

    expect(sandboxModule.Sandbox.get).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "template-key",
        projectId: "prj_123",
        resume: false,
        teamId: "team_123",
        token: "vercel-token",
      }),
    );
    expect(sandboxModule.Sandbox.create).not.toHaveBeenCalled();
  });

  it("persists safe lookup options for restoration without persisting secrets", async () => {
    const sessionSandbox = createMockSandbox({ name: "session-key" });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn().mockResolvedValueOnce(sessionSandbox),
        get: vi.fn().mockResolvedValueOnce(null),
      },
    };
    const provider = createTestVercelSandbox({
      createOptions: {
        projectId: "prj_123",
        tags: { owner: "platform" },
        teamId: "team_123",
        token: "vercel-token",
      } as never,
      loadSandboxModule: async () => sandboxModule as never,
    });

    const handle = await provider.create({
      context: { appRoot: "/tmp/test-app-root" },
      sessionKey: "session-key",
      templateKey: null,
    });

    const state = await handle.captureState();
    expect(state).toMatchObject({
      configuration: {
        projectId: "prj_123",
        tags: { owner: "platform" },
        teamId: "team_123",
      },
    });
    expect(state.configuration).not.toHaveProperty("token");
    expect(state.configuration).not.toHaveProperty("fetch");
  });

  it("includes Vercel SDK error response bodies in provider errors", async () => {
    const sandboxModule = {
      Sandbox: {
        create: vi.fn(),
        get: vi.fn().mockRejectedValue(
          Object.assign(new Error("Status code 400 is not ok"), {
            json: {
              error: {
                code: "bad_request",
                message: "The sandbox request is invalid.",
              },
            },
          }),
        ),
      },
    };

    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await expect(
      provider.prepare({
        context: { appRoot: "/tmp/test-app-root" },
        seedFiles: [],
        templateKey: "template-key",
      }),
    ).rejects.toThrow(/The sandbox request is invalid/);
  });

  it("writes /workspace seed paths through to the sandbox filesystem unchanged", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    const sessionSandbox = createMockSandbox({ name: "session" });
    const sandboxModule = {
      Sandbox: {
        create: vi
          .fn()
          .mockResolvedValueOnce(templateSandbox)
          .mockResolvedValueOnce(sessionSandbox),
        get: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(templateSandbox)
          .mockResolvedValueOnce(null),
      },
    };

    const provider = createTestVercelSandbox({
      createOptions: { image: IMMUTABLE_VERCEL_IMAGE },
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.prepare({
      context: { appRoot: "/tmp/test-app-root" },
      seedFiles: [
        {
          content: "skill body",
          path: "/workspace/skills/weather/SKILL.md",
        },
      ],
      templateKey: "template-key",
    });

    await provider.prepare({
      context: { appRoot: "/tmp/test-app-root" },
      seedFiles: [],
      templateKey: "template-key",
    });

    await provider.create({
      context: { appRoot: "/tmp/test-app-root" },
      sessionKey: "session-key",
      templateKey: "template-key",
    });

    expect(templateSandbox.writeFiles).toHaveBeenCalledTimes(1);

    const files = vi.mocked(templateSandbox.writeFiles).mock.calls[0]?.[0];
    expect(files).toHaveLength(1);
    expect(files?.[0]).toEqual(
      expect.objectContaining({
        path: "/workspace/skills/weather/SKILL.md",
      }),
    );
    expect(files?.[0]?.content).toBeInstanceOf(Buffer);
  });

  it("writes seed files before preparation and snapshots preparation outputs", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn().mockResolvedValueOnce(templateSandbox),
        get: vi.fn().mockResolvedValueOnce(null),
      },
    };
    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.prepare({
      prepare: async (sandbox) => {
        await expect(sandbox.readTextFile({ path: "/workspace/seed.txt" })).resolves.toBe(
          "authored seed",
        );
        await sandbox.writeTextFile({
          content: "preparation output",
          path: "/workspace/preparation.txt",
        });
      },
      context: { appRoot: "/tmp/test-app-root" },
      seedFiles: [{ content: "authored seed", path: "/workspace/seed.txt" }],
      templateKey: "template-key",
    });

    const writes = vi.mocked(templateSandbox.writeFiles);
    expect(writes.mock.calls.map(([files]) => files[0]?.path)).toEqual([
      "/workspace/seed.txt",
      "/workspace/preparation.txt",
    ]);
    expect(writes.mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(templateSandbox.snapshot).mock.invocationCallOrder[0]!,
    );
  });

  it("reports a fresh build when no framework snapshot exists yet", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn().mockResolvedValueOnce(templateSandbox),
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    const result = await provider.prepare({
      context: { appRoot: "/tmp/test-app-root" },
      seedFiles: [],
      templateKey: "template-key",
    });

    expect(result).toMatchObject({
      reused: false,
      reference: {
        snapshotId: "template-snapshot",
        templateKey: "template-key",
      },
    });
    expect(templateSandbox.snapshot).toHaveBeenCalledTimes(1);
  });

  it("recreates a stale stopped Vercel template that has no snapshot", async () => {
    const staleTemplate = createMockSandbox({
      name: "template-key",
      status: "stopped",
    });
    const freshTemplate = createMockSandbox({ name: "template-key" });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn().mockResolvedValueOnce(freshTemplate),
        get: vi.fn().mockResolvedValueOnce(staleTemplate),
      },
    };

    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    const result = await provider.prepare({
      context: { appRoot: "/tmp/test-app-root" },
      seedFiles: [],
      templateKey: "template-key",
    });

    expect(result).toMatchObject({ reused: false });
    expect(staleTemplate.delete).toHaveBeenCalledTimes(1);
    expect(staleTemplate.runCommand).not.toHaveBeenCalled();
    expect(sandboxModule.Sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "template-key",
        persistent: false,
      }),
    );
    expect(freshTemplate.snapshot).toHaveBeenCalledTimes(1);
  });

  it("reports a reuse when an existing template already carries a framework snapshot", async () => {
    const existingTemplate = createMockSandbox({
      name: "template-key",
      snapshotId: "framework-snapshot",
    });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn(),
        get: vi.fn().mockResolvedValue(existingTemplate),
      },
    };

    const provider = createTestVercelSandbox({
      createOptions: { image: IMMUTABLE_VERCEL_IMAGE },
      loadSandboxModule: async () => sandboxModule as never,
    });

    const result = await provider.prepare({
      context: { appRoot: "/tmp/test-app-root" },
      seedFiles: [],
      templateKey: "template-key",
    });

    expect(result).toMatchObject({
      reused: true,
      reference: {
        snapshotId: "framework-snapshot",
        templateKey: "template-key",
      },
    });
    // Reuse must not re-snapshot or re-create the template sandbox.
    expect(existingTemplate.snapshot).not.toHaveBeenCalled();
    expect(sandboxModule.Sandbox.create).not.toHaveBeenCalled();
  });

  it("rebuilds a cached template backed by eve's floating default image", async () => {
    const existingTemplate = createMockSandbox({
      name: "template-key",
      snapshotId: "old-framework-snapshot",
    });
    const rebuiltTemplate = createMockSandbox({ name: "template-key" });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn().mockResolvedValueOnce(rebuiltTemplate),
        get: vi.fn().mockResolvedValueOnce(existingTemplate),
      },
    };
    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    const result = await provider.prepare({
      context: { appRoot: "/tmp/test-app-root" },
      seedFiles: [],
      templateKey: "template-key",
    });

    expect(existingTemplate.delete).toHaveBeenCalledOnce();
    expect(sandboxModule.Sandbox.create).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ reused: false });
  });

  it("deletes a partially prepared template before surfacing the failure", async () => {
    const templateSandbox = createMockSandbox({ name: "template-key" });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn().mockResolvedValueOnce(templateSandbox),
        get: vi.fn().mockResolvedValueOnce(null),
      },
    };
    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await expect(
      provider.prepare({
        prepare: async () => {
          throw new Error("prepare failed");
        },
        context: { appRoot: "/tmp/test-app-root" },
        seedFiles: [],
        templateKey: "template-key",
      }),
    ).rejects.toThrow("prepare failed");

    expect(templateSandbox.delete).toHaveBeenCalledOnce();
    expect(templateSandbox.snapshot).not.toHaveBeenCalled();
  });

  it("rebuilds a cached template when a git base is not pinned to a commit", async () => {
    const existingTemplate = createMockSandbox({
      name: "template-key",
      snapshotId: "old-framework-snapshot",
    });
    const rebuiltTemplate = createMockSandbox({ name: "template-key" });
    const create = vi.fn().mockResolvedValueOnce(rebuiltTemplate);
    const sandboxModule = {
      Sandbox: {
        create,
        get: vi.fn().mockResolvedValueOnce(existingTemplate),
      },
    };
    const provider = createTestVercelSandbox({
      createOptions: {
        source: {
          revision: "main",
          type: "git",
          url: "https://example.com/repo.git",
        },
      },
      createSandbox: async ({ createOptions }) => await create(createOptions),
      loadSandboxModule: async () => sandboxModule as never,
    });

    const result = await provider.prepare({
      context: { appRoot: "/tmp/test-app-root" },
      seedFiles: [],
      templateKey: "template-key",
    });

    expect(existingTemplate.delete).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      reference: { snapshotId: "template-key-snapshot" },
      reused: false,
    });
  });

  it("removes paths through the sandbox filesystem API", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    const sessionSandbox = createMockSandbox({ name: "session" });
    const sandboxModule = {
      Sandbox: {
        create: vi
          .fn()
          .mockResolvedValueOnce(templateSandbox)
          .mockResolvedValueOnce(sessionSandbox),
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.prepare({
      context: { appRoot: "/tmp/test-app-root" },
      seedFiles: [],
      templateKey: "template-key",
    });
    const handle = await provider.create({
      context: { appRoot: "/tmp/test-app-root" },
      sessionKey: "session-key",
      templateKey: "template-key",
    });
    vi.mocked(sessionSandbox.runCommand).mockClear();

    await handle.session.removePath({ force: true, path: "skills/tenant", recursive: true });

    expect(sessionSandbox.fs.rm).toHaveBeenCalledWith("/workspace/skills/tenant", {
      force: true,
      recursive: true,
      signal: undefined,
    });
    expect(sessionSandbox.runCommand).not.toHaveBeenCalled();
  });

  it("applies a 30-minute default timeout to Sandbox.create", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    const sessionSandbox = createMockSandbox({ name: "session" });
    const create = vi
      .fn()
      .mockResolvedValueOnce(templateSandbox)
      .mockResolvedValueOnce(sessionSandbox);
    const sandboxModule = {
      Sandbox: {
        create,
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.prepare({
      context: { appRoot: "/tmp/test-app-root" },
      seedFiles: [],
      templateKey: "template-key",
    });

    await provider.create({
      context: { appRoot: "/tmp/test-app-root" },
      sessionKey: "session-key",
      templateKey: "template-key",
    });

    expect(create).toHaveBeenCalledTimes(2);
    const [templateArgs, sessionArgs] = create.mock.calls;
    expect(templateArgs?.[0]).toMatchObject({ timeout: 30 * 60 * 1_000 });
    expect(sessionArgs?.[0]).toMatchObject({ timeout: 30 * 60 * 1_000 });
  });

  it("applies framework defaults to Sandbox.create when no createOptions are supplied", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    const sessionSandbox = createMockSandbox({ name: "session" });
    const create = vi
      .fn()
      .mockResolvedValueOnce(templateSandbox)
      .mockResolvedValueOnce(sessionSandbox);
    const sandboxModule = {
      Sandbox: {
        create,
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.prepare({
      context: { appRoot: "/tmp/test-app-root" },
      seedFiles: [],
      templateKey: "template-key",
    });

    await provider.create({
      context: { appRoot: "/tmp/test-app-root" },
      sessionKey: "session-key",
      templateKey: "template-key",
    });

    expect(create).toHaveBeenCalledTimes(2);
    const [templateArgs, sessionArgs] = create.mock.calls;
    expect(templateArgs?.[0]).toMatchObject({
      name: "template-key",
      persistent: false,
      timeout: 30 * 60 * 1_000,
    });
    expect(sessionArgs?.[0]).toMatchObject({
      name: "session-key",
      persistent: true,
      timeout: 30 * 60 * 1_000,
      source: { snapshotId: "template-snapshot", type: "snapshot" },
    });
  });

  it("creates a fresh session without reading or snapshotting a template when templateKey is null", async () => {
    const sessionSandbox = createMockSandbox({ name: "session" });
    const create = vi.fn().mockResolvedValueOnce(sessionSandbox);
    const get = vi.fn().mockResolvedValue(null);
    const sandboxModule = {
      Sandbox: {
        create,
        get,
      },
    };

    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.create({
      context: { appRoot: "/tmp/test-app-root" },
      sessionKey: "session-key",
      templateKey: null,
    });

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith({
      fetch: expect.any(Function),
      name: "session-key",
      resume: false,
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      name: "session-key",
      persistent: true,
      timeout: 30 * 60 * 1_000,
    });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("source");
    expect(sessionSandbox.snapshot).not.toHaveBeenCalled();
  });

  it("creates from the exact frozen snapshot without looking up the named template", async () => {
    const sessionSandbox = createMockSandbox({ name: "session-key" });
    const create = vi.fn().mockResolvedValue(sessionSandbox);
    const get = vi.fn().mockResolvedValue(null);
    const provider = createTestVercelSandbox({
      createSandbox: create,
      loadSandboxModule: async () => ({ Sandbox: { create, get } }) as never,
    });

    await provider.create({
      context: { appRoot: "/tmp/test-app-root" },
      sessionKey: "session-key",
      templateKey: "template-key",
      templateReference: {
        sandboxName: "template-key",
        snapshotId: "snapshot-frozen-at-build",
        templateKey: "template-key",
      },
    });

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ name: "session-key" }));
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        source: {
          snapshotId: "snapshot-frozen-at-build",
          type: "snapshot",
        },
      }),
    );
  });

  it("keeps author createOptions on template-less fresh sessions", async () => {
    const sessionSandbox = createMockSandbox({ name: "session" });
    const create = vi.fn().mockResolvedValueOnce(sessionSandbox);
    const sandboxModule = {
      Sandbox: {
        create,
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const provider = createTestVercelSandbox({
      createOptions: {
        ports: [3000],
        source: { snapshotId: "author-snap", type: "snapshot" },
      },
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.create({
      context: { appRoot: "/tmp/test-app-root" },
      sessionKey: "session-key",
      templateKey: null,
    });

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      name: "session-key",
      persistent: true,
      ports: [3000],
      source: { snapshotId: "author-snap", type: "snapshot" },
    });
    expect(sessionSandbox.snapshot).not.toHaveBeenCalled();
  });

  it("forwards factory createOptions to both template and session Sandbox.create", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    const sessionSandbox = createMockSandbox({ name: "session" });
    const create = vi
      .fn()
      .mockResolvedValueOnce(templateSandbox)
      .mockResolvedValueOnce(sessionSandbox);
    const sandboxModule = {
      Sandbox: {
        create,
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const provider = createTestVercelSandbox({
      createOptions: {
        networkPolicy: "deny-all",
        ports: [3000, 4000],
        resources: { vcpus: 2 },
        timeout: 600_000,
      },
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.prepare({
      context: { appRoot: "/tmp/test-app-root" },
      seedFiles: [],
      templateKey: "template-key",
    });

    await provider.create({
      context: { appRoot: "/tmp/test-app-root" },
      sessionKey: "session-key",
      templateKey: "template-key",
    });

    expect(create).toHaveBeenCalledTimes(2);
    const [templateArgs, sessionArgs] = create.mock.calls;
    expect(templateArgs?.[0]).toMatchObject({
      name: "template-key",
      networkPolicy: "allow-all",
      persistent: false,
      ports: [3000, 4000],
      resources: { vcpus: 2 },
      timeout: 600_000,
    });
    expect(sessionArgs?.[0]).toMatchObject({
      name: "session-key",
      networkPolicy: "deny-all",
      persistent: true,
      ports: [3000, 4000],
      resources: { vcpus: 2 },
      source: { snapshotId: "template-snapshot", type: "snapshot" },
      timeout: 600_000,
    });
    expect(templateSandbox.update).toHaveBeenCalledWith({ networkPolicy: "deny-all" });
  });

  it("forwards author source to template create as the base layer", async () => {
    /*
     * The real Vercel SDK pre-populates `currentSnapshotId` on a
     * freshly-created sandbox when the create call passed a snapshot
     * source. The template sandbox mock mirrors that — if eve's
     * "template already has a snapshot, reuse it" guard fires on a
     * newly-created template, it returns the author's snapshotId
     * instead of running preparation/managed files/`sandbox.snapshot()`, so the
     * session would derive directly from the author snapshot and the
     * framework's setup would never run. That's the regression this
     * test pins.
     */
    const templateSandbox = createMockSandbox({
      name: "template",
      snapshotId: "author-snap",
    });
    const sessionSandbox = createMockSandbox({ name: "session" });
    const create = vi
      .fn()
      .mockResolvedValueOnce(templateSandbox)
      .mockResolvedValueOnce(sessionSandbox);
    const sandboxModule = {
      Sandbox: {
        create,
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const provider = createTestVercelSandbox({
      createOptions: { source: { snapshotId: "author-snap", type: "snapshot" } },
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.prepare({
      context: { appRoot: "/tmp/test-app-root" },
      seedFiles: [],
      templateKey: "template-key",
    });

    await provider.create({
      context: { appRoot: "/tmp/test-app-root" },
      sessionKey: "session-key",
      templateKey: "template-key",
    });

    expect(create).toHaveBeenCalledTimes(2);
    const [templateArgs, sessionArgs] = create.mock.calls;
    expect(templateArgs?.[0]).toMatchObject({
      source: { snapshotId: "author-snap", type: "snapshot" },
    });
    expect(templateSandbox.snapshot).toHaveBeenCalledTimes(1);
    expect(sessionArgs?.[0]).toMatchObject({
      source: { snapshotId: "template-snapshot", type: "snapshot" },
    });
  });

  it("re-runs prewarm when an existing template still carries the author snapshot as its currentSnapshotId", async () => {
    /*
     * A previous prewarm that crashed (or just never reached
     * `sandbox.snapshot()`) leaves a named template sandbox in the
     * project whose `currentSnapshotId` is still the author's source
     * snapshot. Without explicit handling, `getNamedSandbox` would
     * find it and eve would treat the author's snapshot as the
     * framework's prewarmed snapshot, skipping setup/preparation/managed files
     * forever. This test pins that we ignore that exact value and
     * proceed with prewarm on the existing sandbox.
     */
    const existingTemplate = createMockSandbox({
      name: "template-key",
      snapshotId: "author-snap",
    });
    const sessionSandbox = createMockSandbox({ name: "session-key" });
    const create = vi.fn().mockResolvedValueOnce(sessionSandbox);
    const get = vi.fn().mockImplementation(async ({ name }: { name: string }) => {
      if (name === "template-key") return existingTemplate;
      if (name === "session-key") return null;
      return null;
    });
    const sandboxModule = { Sandbox: { create, get } };

    const provider = createTestVercelSandbox({
      createOptions: { source: { snapshotId: "author-snap", type: "snapshot" } },
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.prepare({
      context: { appRoot: "/tmp/test-app-root" },
      seedFiles: [],
      templateKey: "template-key",
    });

    await provider.create({
      context: { appRoot: "/tmp/test-app-root" },
      sessionKey: "session-key",
      templateKey: "template-key",
    });

    expect(existingTemplate.snapshot).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      source: { snapshotId: "template-key-snapshot", type: "snapshot" },
    });
  });

  it("invalidates and rebuilds a Vercel template when its snapshot expired before session create", async () => {
    const staleTemplate = createMockSandbox({
      name: "template-key",
      snapshotId: "expired-template-snapshot",
    });
    const freshTemplate = createMockSandbox({ name: "template-key" });
    const sessionSandbox = createMockSandbox({ name: "session-key" });
    let templateDeleted = false;
    vi.mocked(staleTemplate.delete).mockImplementation(async () => {
      templateDeleted = true;
    });

    const snapshotExpiredError = Object.assign(
      new Error("Vercel sandbox create API returned 410"),
      {
        json: {
          error: {
            code: "bad_request",
            message: "Resource is gone.",
          },
        },
        response: { status: 410 },
      },
    );
    const create = vi
      .fn()
      .mockRejectedValueOnce(snapshotExpiredError)
      .mockResolvedValueOnce(freshTemplate)
      .mockResolvedValueOnce(sessionSandbox);
    const get = vi.fn().mockImplementation(async ({ name }: { name: string }) => {
      if (name === "template-key") {
        return templateDeleted ? null : staleTemplate;
      }
      if (name === "session-key") {
        return null;
      }
      return null;
    });
    const sandboxModule = { Sandbox: { create, get } };

    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await expect(
      provider.create({
        context: { appRoot: "/tmp/test-app-root" },
        sessionKey: "session-key",
        templateKey: "template-key",
      }),
    ).rejects.toBeInstanceOf(SandboxTemplateUnavailableError);
    expect(staleTemplate.delete).toHaveBeenCalledTimes(1);

    const prewarmResult = await provider.prepare({
      context: { appRoot: "/tmp/test-app-root" },
      seedFiles: [],
      templateKey: "template-key",
    });
    await provider.create({
      context: { appRoot: "/tmp/test-app-root" },
      sessionKey: "session-key",
      templateKey: "template-key",
    });

    expect(prewarmResult).toMatchObject({ reused: false });
    expect(freshTemplate.snapshot).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(3);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      name: "session-key",
      source: { snapshotId: "expired-template-snapshot", type: "snapshot" },
    });
    expect(create.mock.calls[1]?.[0]).toMatchObject({
      name: "template-key",
      persistent: false,
    });
    expect(create.mock.calls[2]?.[0]).toMatchObject({
      name: "session-key",
      source: { snapshotId: "template-key-snapshot", type: "snapshot" },
    });
  });

  it("rebuilds a Vercel template when the named sandbox disappears during prewarm", async () => {
    const staleTemplate = createMockSandbox({ name: "template-key" });
    const freshTemplate = createMockSandbox({ name: "template-key" });
    const missingTemplateError = Object.assign(new Error("Status code 404 is not ok"), {
      response: { status: 404 },
    });
    vi.mocked(staleTemplate.snapshot).mockRejectedValueOnce(missingTemplateError);

    const create = vi
      .fn()
      .mockResolvedValueOnce(staleTemplate)
      .mockResolvedValueOnce(freshTemplate);
    const sandboxModule = {
      Sandbox: {
        create,
        get: vi.fn().mockResolvedValue(null),
      },
    };
    const log = vi.fn();

    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await expect(
      provider.prepare({
        log,
        context: { appRoot: "/tmp/test-app-root" },
        seedFiles: [],
        templateKey: "template-key",
      }),
    ).resolves.toMatchObject({ reused: false });

    expect(create).toHaveBeenCalledTimes(2);
    expect(staleTemplate.snapshot).toHaveBeenCalledTimes(1);
    expect(freshTemplate.snapshot).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("cached template disappeared; rebuilding sandbox template");
  });

  it("resumes a stopped session sandbox via Sandbox.get instead of creating a new one", async () => {
    const templateSandbox = createMockSandbox({
      name: "template-key",
      snapshotId: "template-snapshot",
    });
    const sessionSandbox = createMockSandbox({ name: "persisted-sandbox-name" });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn(),
        get: vi.fn().mockImplementation(async ({ name }: { name: string }) => {
          if (name === "template-key") return templateSandbox;
          if (name === "persisted-sandbox-name") return sessionSandbox;
          return null;
        }),
      },
    };

    const provider = createTestVercelSandbox({
      createOptions: { image: IMMUTABLE_VERCEL_IMAGE },
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.prepare({
      context: { appRoot: "/tmp/test-app-root" },
      seedFiles: [],
      templateKey: "template-key",
    });

    const handle = await provider.create({
      existingMetadata: {
        sandboxCreatedAt: sessionSandbox.createdAt.toISOString(),
        sandboxName: "persisted-sandbox-name",
      },
      context: { appRoot: "/tmp/test-app-root" },
      sessionKey: "session-key",
      templateKey: "template-key",
    });

    expect(sandboxModule.Sandbox.create).not.toHaveBeenCalled();
    expect(sandboxModule.Sandbox.get).toHaveBeenCalledWith({
      fetch: expect.any(Function),
      name: "persisted-sandbox-name",
      resume: false,
    });
    expect(handle.session).toBeDefined();

    const state = await handle.captureState();
    expect(state.metadata).toEqual({
      sandboxCreatedAt: sessionSandbox.createdAt.toISOString(),
      sandboxName: "persisted-sandbox-name",
    });
  });

  it("reuses one named Vercel sandbox across independent provider instances", async () => {
    const resources = new Map<string, ReturnType<typeof createMockSandbox>>();
    const create = vi.fn(async (createOptions: { name: string }) => {
      const sandbox = createMockSandbox({ name: createOptions.name });
      resources.set(createOptions.name, sandbox);
      return sandbox;
    });
    const get = vi.fn(async ({ name }: { name: string }) => resources.get(name) ?? null);
    const sandboxModule = { Sandbox: { create, get } };
    const createProvider = () =>
      createTestVercelSandbox({
        createSandbox: async ({ createOptions }) => (await create(createOptions)) as never,
        loadSandboxModule: async () => sandboxModule as never,
      });
    const createInput = {
      context: { appRoot: "/tmp/test-app-root" },
      sessionKey: "team-acme-workspace",
      templateKey: "template-key",
      templateReference: {
        sandboxName: "template-key",
        snapshotId: "snapshot-frozen-at-build",
        templateKey: "template-key",
      },
    } as const;

    const first = await createProvider().create(createInput);
    const second = await createProvider().create(createInput);

    expect(create).toHaveBeenCalledOnce();
    await expect(first.captureState()).resolves.toMatchObject({
      metadata: {
        sandboxCreatedAt: expect.any(String),
        sandboxName: "team-acme-workspace",
      },
    });
    await expect(second.captureState()).resolves.toMatchObject({
      metadata: {
        sandboxCreatedAt: expect.any(String),
        sandboxName: "team-acme-workspace",
      },
    });
  });

  it("reconnects when another request wins a named sandbox create race", async () => {
    const racedSandbox = createMockSandbox({ name: "team-acme-workspace" });
    const get = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(racedSandbox);
    const create = vi.fn().mockRejectedValue(new Error("name already exists"));
    const sandboxModule = { Sandbox: { create, get } };
    const provider = createTestVercelSandbox({
      createSandbox: async () => await create(),
      loadSandboxModule: async () => sandboxModule as never,
    });

    const handle = await provider.create({
      context: { appRoot: "/tmp/test-app-root" },
      sessionKey: "team-acme-workspace",
      templateKey: null,
    });

    expect(create).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledTimes(2);
    await expect(handle.captureState()).resolves.toMatchObject({
      metadata: {
        sandboxCreatedAt: expect.any(String),
        sandboxName: "team-acme-workspace",
      },
    });
  });

  it("stops the session sandbox on shutdown so no VM outlives the server", async () => {
    const { handle, sessionSandbox } = await createTestVercelSession();

    await handle.shutdown();

    expect(sessionSandbox.stop).toHaveBeenCalledTimes(1);
  });

  it("skips the stop call on shutdown when the sandbox is not running", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    const sessionSandbox = createMockSandbox({ name: "session", status: "stopped" });
    const sandboxModule = {
      Sandbox: {
        create: vi
          .fn()
          .mockResolvedValueOnce(templateSandbox)
          .mockResolvedValueOnce(sessionSandbox),
        get: vi.fn().mockResolvedValue(null),
      },
    };
    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });
    await provider.prepare({
      context: { appRoot: "/tmp/test-app-root" },
      seedFiles: [],
      templateKey: "template-key",
    });
    const handle = await provider.create({
      context: { appRoot: "/tmp/test-app-root" },
      sessionKey: "session-key",
      templateKey: "template-key",
    });

    await handle.shutdown();

    expect(sessionSandbox.stop).not.toHaveBeenCalled();
  });

  it("does not replace a persisted sandbox that no longer exists", async () => {
    const templateSandbox = createMockSandbox({
      name: "template-key",
      snapshotId: "template-snapshot",
    });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn(),
        get: vi.fn().mockImplementation(async ({ name }: { name: string }) => {
          if (name === "template-key") return templateSandbox;
          throw Object.assign(new Error("Not found"), {
            response: { status: 404 },
          });
        }),
      },
    };

    const provider = createTestVercelSandbox({
      createOptions: { image: IMMUTABLE_VERCEL_IMAGE },
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.prepare({
      context: { appRoot: "/tmp/test-app-root" },
      seedFiles: [],
      templateKey: "template-key",
    });

    const create = provider.create({
      existingMetadata: {
        sandboxCreatedAt: "2026-07-30T12:00:00.000Z",
        sandboxName: "deleted-sandbox",
      },
      context: { appRoot: "/tmp/test-app-root" },
      sessionKey: "session-key",
      templateKey: "template-key",
    });
    await expect(create).rejects.toBeInstanceOf(SandboxResourceUnavailableError);
    await expect(create).rejects.toThrow(
      'Persisted sandbox "deleted-sandbox" is unavailable from provider "vercel"',
    );

    expect(sandboxModule.Sandbox.get).toHaveBeenCalledWith({
      fetch: expect.any(Function),
      name: "deleted-sandbox",
      resume: false,
    });
    expect(sandboxModule.Sandbox.create).not.toHaveBeenCalled();
  });

  it("does not accept a replacement sandbox created under a persisted name", async () => {
    const replacement = createMockSandbox({
      createdAt: new Date("2026-07-30T13:00:00.000Z"),
      name: "shared-workspace",
    });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn(),
        get: vi.fn().mockResolvedValue(replacement),
      },
    };
    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await expect(
      provider.create({
        existingMetadata: {
          sandboxCreatedAt: "2026-07-30T12:00:00.000Z",
          sandboxName: "shared-workspace",
        },
        context: { appRoot: "/tmp/test-app-root" },
        sessionKey: "session-key",
        templateKey: null,
      }),
    ).rejects.toBeInstanceOf(SandboxResourceUnavailableError);

    expect(sandboxModule.Sandbox.create).not.toHaveBeenCalled();
  });

  it("does not call Sandbox.create on resume and does not re-apply factory createOptions", async () => {
    const templateSandbox = createMockSandbox({
      name: "template-key",
      snapshotId: "template-snapshot",
    });
    const sessionSandbox = createMockSandbox({ name: "session-key" });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn(),
        get: vi.fn().mockImplementation(async ({ name }: { name: string }) => {
          if (name === "template-key") return templateSandbox;
          if (name === "session-key") return sessionSandbox;
          return null;
        }),
      },
    };

    const provider = createTestVercelSandbox({
      createOptions: { image: IMMUTABLE_VERCEL_IMAGE, networkPolicy: "deny-all" },
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.prepare({
      context: { appRoot: "/tmp/test-app-root" },
      seedFiles: [],
      templateKey: "template-key",
    });

    await provider.create({
      context: { appRoot: "/tmp/test-app-root" },
      sessionKey: "session-key",
      templateKey: "template-key",
    });

    expect(sandboxModule.Sandbox.create).not.toHaveBeenCalled();
    // The factory's networkPolicy must NOT leak into a sandbox.update on resume.
    const updateCalls = vi.mocked(sessionSandbox.update).mock.calls;
    for (const call of updateCalls) {
      expect(call[0]).not.toHaveProperty("networkPolicy");
    }
  });

  it("adds eve sandbox tags to Vercel template and session creation", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    const sessionSandbox = createMockSandbox({ name: "session" });
    const create = vi
      .fn()
      .mockResolvedValueOnce(templateSandbox)
      .mockResolvedValueOnce(sessionSandbox);
    const sandboxModule = {
      Sandbox: {
        create,
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.prepare({
      context: { appRoot: "/tmp/test-app-root" },
      seedFiles: [],
      templateKey: "template-key",
    });

    await provider.create({
      context: { appRoot: "/tmp/test-app-root" },
      sessionKey: "session-key",
      tags: {
        agent: "weather-agent",
        channel: "slack",
        sessionId: "session_123",
      },
      templateKey: "template-key",
    });

    expect(create).toHaveBeenCalledTimes(2);
    const [templateArgs, sessionArgs] = create.mock.calls;
    expect(templateArgs?.[0]).toMatchObject({
      name: "template-key",
      persistent: false,
    });
    expect(sessionArgs?.[0]).toMatchObject({
      name: "session-key",
      persistent: true,
      tags: {
        agent: "weather-agent",
        channel: "slack",
        sessionId: "session_123",
      },
    });
  });

  it("forwards network policy changes through the sandbox session", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    const sessionSandbox = createMockSandbox({ name: "session" });
    const sandboxModule = {
      Sandbox: {
        create: vi
          .fn()
          .mockResolvedValueOnce(templateSandbox)
          .mockResolvedValueOnce(sessionSandbox),
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.prepare({
      context: { appRoot: "/tmp/test-app-root" },
      seedFiles: [],
      templateKey: "template-key",
    });

    const handle = await provider.create({
      context: { appRoot: "/tmp/test-app-root" },
      sessionKey: "session-key",
      templateKey: "template-key",
    });

    await handle.session.setNetworkPolicy("allow-all");
    await handle.session.setNetworkPolicy("deny-all");
    await handle.session.setNetworkPolicy({ allow: ["example.com", "*.vercel.app"] });
    await handle.session.setNetworkPolicy({
      allow: {
        "api.example.com": [{ transform: [{ headers: { authorization: "Bearer sk-..." } }] }],
      },
    });

    expect(sessionSandbox.update).toHaveBeenCalledTimes(4);
    expect(sessionSandbox.update).toHaveBeenNthCalledWith(1, { networkPolicy: "allow-all" });
    expect(sessionSandbox.update).toHaveBeenNthCalledWith(2, { networkPolicy: "deny-all" });
    expect(sessionSandbox.update).toHaveBeenNthCalledWith(3, {
      networkPolicy: { allow: ["example.com", "*.vercel.app"] },
    });
    expect(sessionSandbox.update).toHaveBeenNthCalledWith(4, {
      networkPolicy: {
        allow: {
          "api.example.com": [{ transform: [{ headers: { authorization: "Bearer sk-..." } }] }],
        },
      },
    });
  });

  it("brokers credentials through the session's setNetworkPolicy to sandbox.update", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    const sessionSandbox = createMockSandbox({ name: "session" });
    const sandboxModule = {
      Sandbox: {
        create: vi
          .fn()
          .mockResolvedValueOnce(templateSandbox)
          .mockResolvedValueOnce(sessionSandbox),
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.prepare({
      context: { appRoot: "/tmp/test-app-root" },
      seedFiles: [],
      templateKey: "template-key",
    });

    const handle = await provider.create({
      context: { appRoot: "/tmp/test-app-root" },
      sessionKey: "session-key",
      templateKey: "template-key",
    });

    await handle.session.setNetworkPolicy({
      allow: {
        "github.com": [{ transform: [{ headers: { authorization: "Basic eC1hY2Nlc3M=" } }] }],
        "*": [],
      },
    });

    expect(sessionSandbox.update).toHaveBeenCalledTimes(1);
    expect(sessionSandbox.update).toHaveBeenCalledWith({
      networkPolicy: {
        allow: {
          "github.com": [{ transform: [{ headers: { authorization: "Basic eC1hY2Nlc3M=" } }] }],
          "*": [],
        },
      },
    });
  });

  it("allows preparation to update the template network policy", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    const sessionSandbox = createMockSandbox({ name: "session" });
    const sandboxModule = {
      Sandbox: {
        create: vi
          .fn()
          .mockResolvedValueOnce(templateSandbox)
          .mockResolvedValueOnce(sessionSandbox),
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.prepare({
      prepare: async (sandbox) => {
        await sandbox.setNetworkPolicy("deny-all");
      },
      context: { appRoot: "/tmp/test-app-root" },
      seedFiles: [],
      templateKey: "template-key",
    });

    expect(templateSandbox.update).toHaveBeenCalledWith({ networkPolicy: "deny-all" });
    expect(templateSandbox.snapshot).toHaveBeenCalledTimes(1);
  });

  it("does not call sandbox.update when preparation leaves network policy unchanged", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn().mockResolvedValueOnce(templateSandbox),
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.prepare({
      prepare: async () => {},
      context: { appRoot: "/tmp/test-app-root" },
      seedFiles: [],
      templateKey: "template-key",
    });

    expect(templateSandbox.update).not.toHaveBeenCalled();
    expect(templateSandbox.snapshot).toHaveBeenCalledTimes(1);
  });

  it("updates tags when reattaching existing Vercel sandboxes", async () => {
    const templateSandbox = createMockSandbox({
      name: "template-key",
      snapshotId: "template-snapshot",
      tags: { agent: "old-agent" },
    });
    const sessionSandbox = createMockSandbox({
      name: "session-key",
      tags: { agent: "old-agent" },
    });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn(),
        get: vi.fn().mockImplementation(async ({ name }: { name: string }) => {
          if (name === "template-key") {
            return templateSandbox;
          }
          if (name === "session-key") {
            return sessionSandbox;
          }
          return null;
        }),
      },
    };

    const provider = createTestVercelSandbox({
      createOptions: { image: IMMUTABLE_VERCEL_IMAGE },
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.prepare({
      context: { appRoot: "/tmp/test-app-root" },
      seedFiles: [],
      templateKey: "template-key",
    });

    await provider.create({
      context: { appRoot: "/tmp/test-app-root" },
      sessionKey: "session-key",
      tags: {
        agent: "weather-agent",
        channel: "slack",
        sessionId: "session_123",
      },
      templateKey: "template-key",
    });

    expect(sandboxModule.Sandbox.create).not.toHaveBeenCalled();
    expect(sessionSandbox.update).toHaveBeenCalledWith({
      tags: {
        agent: "weather-agent",
        channel: "slack",
        sessionId: "session_123",
      },
    });
  });

  it("does not retag a persisted sandbox borrowed by a child", async () => {
    const sessionSandbox = createMockSandbox({
      name: "root-session",
      tags: { agent: "root-agent", owner: "platform" },
    });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn(),
        get: vi.fn().mockResolvedValue(sessionSandbox),
      },
    };
    const provider = createTestVercelSandbox({
      createOptions: { tags: { owner: "platform" } },
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.create({
      context: { appRoot: "/tmp/test-app-root" },
      existingMetadata: {
        sandboxCreatedAt: sessionSandbox.createdAt.toISOString(),
        sandboxName: "root-session",
      },
      sessionKey: "root-session",
      templateKey: null,
    });

    expect(sessionSandbox.update).not.toHaveBeenCalled();
  });

  it("rejects merged Vercel sandbox tags over the platform limit", async () => {
    const sandboxModule = {
      Sandbox: {
        create: vi.fn(),
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await expect(
      provider.create({
        context: { appRoot: "/tmp/test-app-root" },
        sessionKey: "session-key",
        tags: {
          agent: "weather-agent",
          channel: "slack",
          env: "test",
          owner: "ai",
          sessionId: "session_123",
          team: "infra",
        },
        templateKey: "template-key",
      }),
    ).rejects.toThrow(/supports at most 5 tags/);
    expect(sandboxModule.Sandbox.create).not.toHaveBeenCalled();
  });

  it("exposes /workspace-rooted resolved paths through the public session", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    const sessionSandbox = createMockSandbox({ name: "session" });
    const sandboxModule = {
      Sandbox: {
        create: vi
          .fn()
          .mockResolvedValueOnce(templateSandbox)
          .mockResolvedValueOnce(sessionSandbox),
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.prepare({
      context: { appRoot: "/tmp/test-app-root" },
      seedFiles: [],
      templateKey: "template-key",
    });

    const handle = await provider.create({
      context: { appRoot: "/tmp/test-app-root" },
      sessionKey: "session-key",
      templateKey: "template-key",
    });

    expect(handle.session.resolvePath("/workspace/python-analysis/run.py")).toBe(
      "/workspace/python-analysis/run.py",
    );
    expect(handle.session.resolvePath("python-analysis/run.py")).toBe(
      "/workspace/python-analysis/run.py",
    );
  });

  it("converts Vercel Node file streams to the public Web stream contract", async () => {
    const { handle, sessionSandbox } = await createTestVercelSession();
    sessionSandbox.readFile.mockResolvedValueOnce(
      Readable.from([Buffer.from("hello "), Buffer.from("sandbox")]),
    );

    const stream = await handle.session.readFile({ path: "/workspace/message.txt" });

    expect(stream).not.toBeNull();
    expect(await consumeWebStream(stream!)).toBe("hello sandbox");
    expect(sessionSandbox.readFile).toHaveBeenCalledWith({ path: "/workspace/message.txt" });
  });

  it("passes existing Web file streams through unchanged", async () => {
    const { handle, sessionSandbox } = await createTestVercelSession();
    const providerStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("web stream"));
        controller.close();
      },
    });
    sessionSandbox.readFile.mockResolvedValueOnce(providerStream);

    const stream = await handle.session.readFile({ path: "/workspace/message.txt" });

    expect(stream).toBe(providerStream);
    expect(await consumeWebStream(stream!)).toBe("web stream");
  });

  it("preserves missing Vercel files as null", async () => {
    const { handle } = await createTestVercelSession();

    await expect(handle.session.readFile({ path: "/workspace/missing.txt" })).resolves.toBeNull();
  });

  it("propagates Vercel file-read errors unchanged", async () => {
    const { handle, sessionSandbox } = await createTestVercelSession();
    const providerError = new Error("provider read failed");
    sessionSandbox.readFile.mockRejectedValueOnce(providerError);

    await expect(handle.session.readFile({ path: "/workspace/message.txt" })).rejects.toBe(
      providerError,
    );
  });

  it("rejects unsupported Vercel file-stream values", async () => {
    const { handle, sessionSandbox } = await createTestVercelSession();
    sessionSandbox.readFile.mockResolvedValueOnce({ readable: true });

    await expect(handle.session.readFile({ path: "/workspace/message.txt" })).rejects.toThrow(
      "Vercel Sandbox returned an unsupported file stream.",
    );
  });

  it("forwards env to runCommand when spawning a process", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    const sessionSandbox = createMockSandbox({ name: "session" });
    const sandboxModule = {
      Sandbox: {
        create: vi
          .fn()
          .mockResolvedValueOnce(templateSandbox)
          .mockResolvedValueOnce(sessionSandbox),
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.prepare({
      context: { appRoot: "/tmp/test-app-root" },
      seedFiles: [],
      templateKey: "template-key",
    });
    const handle = await provider.create({
      context: { appRoot: "/tmp/test-app-root" },
      sessionKey: "session-key",
      templateKey: "template-key",
    });

    vi.mocked(sessionSandbox.runCommand).mockResolvedValue(createMockDetachedCommand() as never);
    vi.mocked(sessionSandbox.runCommand).mockClear();

    await handle.session.spawn({
      command: "printenv DEPLOY_ENV",
      env: { DEPLOY_ENV: "staging" },
    });

    expect(sessionSandbox.runCommand).toHaveBeenCalledTimes(1);
    expect(sessionSandbox.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["-lc", "printenv DEPLOY_ENV"],
        cmd: "bash",
        env: { DEPLOY_ENV: "staging" },
      }),
    );
  });

  it("forwards env to runCommand when running a command", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    const sessionSandbox = createMockSandbox({ name: "session" });
    const sandboxModule = {
      Sandbox: {
        create: vi
          .fn()
          .mockResolvedValueOnce(templateSandbox)
          .mockResolvedValueOnce(sessionSandbox),
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.prepare({
      context: { appRoot: "/tmp/test-app-root" },
      seedFiles: [],
      templateKey: "template-key",
    });
    const handle = await provider.create({
      context: { appRoot: "/tmp/test-app-root" },
      sessionKey: "session-key",
      templateKey: "template-key",
    });

    vi.mocked(sessionSandbox.runCommand).mockResolvedValue(createMockDetachedCommand() as never);
    vi.mocked(sessionSandbox.runCommand).mockClear();

    await handle.session.run({
      command: "printenv DEPLOY_ENV",
      env: { DEPLOY_ENV: "production" },
    });

    expect(sessionSandbox.runCommand).toHaveBeenCalledTimes(1);
    expect(sessionSandbox.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["-lc", "printenv DEPLOY_ENV"],
        cmd: "bash",
        env: { DEPLOY_ENV: "production" },
      }),
    );
  });

  it("exposes a stable provider name", () => {
    const provider = createTestVercelSandbox();
    expect(provider.provider).toBe("vercel");
  });

  it("prepares the base runtime during sandbox init", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    const sessionSandbox = createMockSandbox({ name: "session" });
    const sandboxModule = {
      Sandbox: {
        create: vi
          .fn()
          .mockResolvedValueOnce(templateSandbox)
          .mockResolvedValueOnce(sessionSandbox),
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.prepare({
      context: { appRoot: "/tmp/test-app-root" },
      seedFiles: [],
      templateKey: "template-key",
    });

    await provider.create({
      context: { appRoot: "/tmp/test-app-root" },
      sessionKey: "session-key",
      templateKey: "template-key",
    });

    const templateCalls = vi.mocked(templateSandbox.runCommand).mock.calls;
    expect(templateCalls).toHaveLength(1);

    const setupCall = templateCalls[0]?.[0] as {
      args?: string[];
      cmd?: string;
      sudo?: boolean;
    };
    expect(setupCall).toMatchObject({ cmd: "bash" });
    expect(setupCall.sudo).toBeUndefined();
    const setupScript = setupCall.args?.[1] ?? "";
    expect(setupScript).toContain("mkdir -p /workspace");
    expect(setupScript).toContain("command -v bash");
    expect(setupScript).not.toContain("apt-get");
    expect(setupScript).not.toContain("gpgv");
    expect(setupScript).not.toContain("node --version");
    expect(setupScript).not.toContain("npm");
    expect(setupScript).not.toContain("python3");
    expect(setupScript).not.toContain("ripgrep");
    expect(setupScript).not.toContain("sudo mkdir");
    expect(setupScript).not.toContain("chown");
  });

  it("retries base runtime setup through sudo when the default user fails", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    vi.mocked(templateSandbox.runCommand)
      .mockResolvedValueOnce({
        exitCode: 70,
        stderr: vi.fn().mockResolvedValue("the sandbox image must provide bash\n"),
        stdout: vi.fn().mockResolvedValue(""),
      } as never)
      .mockResolvedValueOnce(createMockCommandResult() as never);

    const sandboxModule = {
      Sandbox: {
        create: vi.fn().mockResolvedValueOnce(templateSandbox),
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.prepare({
      context: { appRoot: "/tmp/test-app-root" },
      seedFiles: [],
      templateKey: "template-key",
    });

    expect(templateSandbox.runCommand).toHaveBeenCalledTimes(2);
    const firstCall = vi.mocked(templateSandbox.runCommand).mock.calls[0]?.[0] as {
      args?: string[];
      cmd?: string;
    };
    const secondCall = vi.mocked(templateSandbox.runCommand).mock.calls[1]?.[0] as {
      args?: string[];
      cmd?: string;
      sudo?: boolean;
    };
    expect(firstCall).toMatchObject({ args: ["-lc", expect.any(String)], cmd: "bash" });
    expect(secondCall).toMatchObject({
      args: ["-n", "bash", "-lc", firstCall.args?.[1]],
      cmd: "sudo",
    });
    expect(secondCall.sudo).toBeUndefined();
  });

  it("does not append auth guidance to non-auth prewarm errors", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    vi.mocked(templateSandbox.runCommand).mockResolvedValue({
      exitCode: 1,
      stderr: vi.fn().mockResolvedValue("the sandbox image must provide bash\n"),
      stdout: vi.fn().mockResolvedValue(""),
    } as never);

    const sandboxModule = {
      Sandbox: {
        create: vi.fn().mockResolvedValueOnce(templateSandbox),
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    const prewarm = provider.prepare({
      context: { appRoot: "/tmp/test-app-root" },
      seedFiles: [],
      templateKey: "template-key",
    });

    await expect(prewarm).rejects.toThrow(/Failed to initialize Vercel sandbox base runtime/);
    await expect(prewarm).rejects.not.toThrow(/Vercel OIDC can authenticate/);
  });
});

describe("createVercelSandbox", () => {
  it("returns the internal Vercel provider bridge", () => {
    const provider = createVercelSandbox();
    expect(provider.provider).toBe("vercel");
    expect(typeof provider.create).toBe("function");
    expect(typeof provider.prepare).toBe("function");
  });
});
