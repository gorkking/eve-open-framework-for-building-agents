import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearActiveSandboxHandlesForTest,
  countActiveSandboxHandles,
  shutdownActiveSandboxHandles,
} from "#execution/sandbox/active-handles.js";
import { ensureSandboxAccess } from "#execution/sandbox/ensure.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import type { SandboxDefinitionContext } from "#public/definitions/sandbox.js";
import {
  createBundledRuntimeCompiledArtifactsSource,
  createDiskRuntimeCompiledArtifactsSource,
  type RuntimeCompiledArtifactsSource,
} from "#runtime/compiled-artifacts-source.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import type { SandboxState, SandboxStateValue } from "#sandbox/state.js";
import type { JsonObject } from "#shared/json.js";
import { defineSandboxTemplate, type SandboxTemplate } from "#shared/sandbox-template.js";
import { defineSandboxAdapter, type Sandbox } from "#shared/sandbox-value.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

const mocks = vi.hoisted(() => ({
  prewarmAppSandboxes: vi.fn(async () => {}),
  waitForSandboxTemplatePrewarmLock: vi.fn(async () => {}),
  waitForDevelopmentSandboxPrewarm: vi.fn(async () => {}),
}));

vi.mock("#execution/sandbox/development-prewarm.js", () => ({
  waitForDevelopmentSandboxPrewarm: mocks.waitForDevelopmentSandboxPrewarm,
}));
vi.mock("#execution/sandbox/prewarm.js", () => ({
  prewarmAppSandboxes: mocks.prewarmAppSandboxes,
}));
vi.mock("#execution/sandbox/template-prewarm-lock.js", () => ({
  waitForSandboxTemplatePrewarmLock: mocks.waitForSandboxTemplatePrewarmLock,
}));

interface TestSandboxReference extends JsonObject {
  readonly id: string;
}

interface TestSandboxHandle {
  readonly id: string;
  readonly session: SandboxSession;
}

const testSandboxes = new Map<string, TestSandboxHandle>();
const restoreTestSandbox = vi.fn((reference: TestSandboxReference) => {
  const handle = testSandboxes.get(reference.id);
  if (handle === undefined) {
    throw new Error(`Missing test sandbox "${reference.id}".`);
  }
  return handle;
});
const shutdownTestSandbox = vi.fn();
const asTestSandbox = defineSandboxAdapter<TestSandboxHandle, TestSandboxReference>({
  reference(handle) {
    return { id: handle.id };
  },
  restore(reference) {
    return restoreTestSandbox(reference);
  },
  session(handle) {
    return handle.session;
  },
  shutdown(handle) {
    shutdownTestSandbox(handle.id);
  },
});

function createTestSandbox(id: string): Sandbox {
  const handle = {
    id,
    session: mockSandbox({ id }).session,
  };
  testSandboxes.set(id, handle);
  return asTestSandbox(handle);
}

function createTestRegistry(input: {
  readonly definition: RuntimeSandboxRegistry["sandbox"]["definition"]["definition"];
  readonly sourceHash?: string;
  readonly templates?: ReadonlyArray<{
    readonly exportName: string;
    readonly reference?: unknown;
    readonly template: SandboxTemplate;
  }>;
}): RuntimeSandboxRegistry {
  return {
    sandbox: {
      definition: {
        definition: input.definition,
        logicalPath: "agent/sandbox/sandbox.ts",
        sourceHash: input.sourceHash ?? "test-source-hash",
        sourceId: "agent/sandbox/sandbox",
        sourceKind: "module",
        templates: input.templates ?? [],
      },
      workspaceResourceRoot: { logicalPath: "", rootEntries: [] },
    },
  };
}

async function ensure(input: {
  readonly compiledArtifactsSource?: RuntimeCompiledArtifactsSource;
  readonly nodeId?: string;
  readonly parentState?: SandboxStateValue;
  readonly registry: RuntimeSandboxRegistry;
  readonly rootState?: SandboxStateValue;
  readonly signal?: AbortSignal;
  readonly sessionId?: string;
  readonly state?: SandboxState | null;
}) {
  const sessionId = input.sessionId ?? "session_1";
  return await ensureSandboxAccess({
    compiledArtifactsSource:
      input.compiledArtifactsSource ?? createBundledRuntimeCompiledArtifactsSource(),
    nodeId: input.nodeId ?? "__root__",
    parentState: input.parentState,
    registry: input.registry,
    rootState: input.rootState,
    signal: input.signal,
    session: createSession(sessionId),
    sessionId,
    state: input.state ?? null,
  });
}

function createSession(sessionId: string): SandboxDefinitionContext["session"] {
  return {
    auth: {
      current: {
        attributes: { teamId: "team_1" },
        authenticator: "test",
        issuer: "test",
        principalId: "user_1",
        principalType: "user",
      },
      initiator: null,
    },
    id: sessionId,
    turn: { id: "turn_1", sequence: 0 },
  };
}

describe("ensureSandboxAccess", () => {
  beforeEach(() => {
    clearActiveSandboxHandlesForTest();
    testSandboxes.clear();
    restoreTestSandbox.mockClear();
    shutdownTestSandbox.mockClear();
    mocks.prewarmAppSandboxes.mockClear();
    mocks.waitForDevelopmentSandboxPrewarm.mockClear();
    mocks.waitForSandboxTemplatePrewarmLock.mockClear();
  });

  it("invokes the definition lazily with session and runtime context", async () => {
    const signal = new AbortController().signal;
    const definition = vi.fn(() => createTestSandbox("sandbox_1"));
    const access = await ensure({
      registry: createTestRegistry({ definition }),
      signal,
    });

    expect(definition).not.toHaveBeenCalled();
    expect(await access.captureState()).toBeNull();

    await expect(access.get()).resolves.toMatchObject({ id: "sandbox_1" });
    expect(definition).toHaveBeenCalledWith({
      parent: null,
      root: null,
      runtime: { mode: expect.stringMatching(/^(development|production)$/) },
      session: expect.objectContaining({
        auth: expect.objectContaining({
          current: expect.objectContaining({ principalId: "user_1" }),
        }),
        id: "session_1",
      }),
      signal,
    });
  });

  it("restores persisted provider state without invoking the definition again", async () => {
    const definition = vi.fn(() => createTestSandbox("sandbox_1"));
    const registry = createTestRegistry({ definition });
    const first = await ensure({ registry });

    await first.get();
    const state = await first.captureState();
    expect(state).not.toBeNull();
    expect(state?.value).toMatchObject({
      id: "sandbox_1",
      reference: { id: "sandbox_1" },
    });

    const second = await ensure({ registry, state });
    const restored = await second.get();
    await restored?.run({ command: "true" });

    expect(definition).toHaveBeenCalledTimes(1);
    expect(restoreTestSandbox).toHaveBeenCalledWith({ id: "sandbox_1" });
  });

  it("invokes the definition again when its private compatibility revision changes", async () => {
    const firstDefinition = vi.fn(() => createTestSandbox("sandbox_1"));
    const first = await ensure({
      registry: createTestRegistry({
        definition: firstDefinition,
        sourceHash: "source-v1",
      }),
    });
    await first.get();
    const state = await first.captureState();

    const secondDefinition = vi.fn(() => createTestSandbox("sandbox_2"));
    const second = await ensure({
      registry: createTestRegistry({
        definition: secondDefinition,
        sourceHash: "source-v2",
      }),
      state,
    });

    await expect(second.get()).resolves.toMatchObject({ id: "sandbox_2" });
    expect(secondDefinition).toHaveBeenCalledTimes(1);
    expect(restoreTestSandbox).not.toHaveBeenCalled();
  });

  it("exposes durable parent and root sandboxes and preserves borrowed ownership", async () => {
    const root = await ensure({
      registry: createTestRegistry({
        definition: () => createTestSandbox("root-sandbox"),
      }),
      sessionId: "root-session",
    });
    await root.get();
    const rootState = await root.captureState();
    expect(rootState).not.toBeNull();

    const childDefinition = vi.fn(async ({ parent, root: rootAncestor }) => {
      expect((await parent?.sandbox)?.id).toBe("root-sandbox");
      expect((await rootAncestor?.sandbox)?.id).toBe("root-sandbox");
      return await parent!.sandbox;
    });
    const child = await ensure({
      nodeId: "reviewer",
      parentState: rootState!,
      registry: createTestRegistry({ definition: childDefinition }),
      rootState: rootState!,
      sessionId: "child-session",
    });

    await expect(child.get()).resolves.toMatchObject({ id: "root-sandbox" });
    expect(await child.captureState()).toMatchObject({
      owner: {
        nodeId: "__root__",
        sessionId: "root-session",
      },
      root: rootState,
    });
  });

  it("binds the exact compiled template reference before invoking the definition", async () => {
    const create = vi.fn(({ reference }: { reference: { snapshotId: string } }) =>
      createTestSandbox(reference.snapshotId),
    );
    const template = defineSandboxTemplate<{ snapshotId: string }, Record<string, never>>({
      async prewarm() {
        return { snapshotId: "prewarmed" };
      },
      create,
    });
    const registry = createTestRegistry({
      definition: () => template.create({}),
      templates: [
        {
          exportName: "template",
          reference: { snapshotId: "snapshot_123" },
          template,
        },
      ],
    });

    const access = await ensure({ registry });
    await expect(access.get()).resolves.toMatchObject({ id: "snapshot_123" });
    expect(create).toHaveBeenCalledWith({
      options: {},
      reference: { snapshotId: "snapshot_123" },
    });
  });

  it("waits for development prewarm before invoking a templated definition", async () => {
    const waiting = createDeferred<void>();
    mocks.waitForDevelopmentSandboxPrewarm.mockReturnValueOnce(waiting.promise);
    const template = defineSandboxTemplate<{ snapshotId: string }, Record<string, never>>({
      async prewarm() {
        return { snapshotId: "snapshot_1" };
      },
      create() {
        return createTestSandbox("sandbox_1");
      },
    });
    const definition = vi.fn(() => template.create({}));
    const appRoot = process.cwd();
    const access = await ensure({
      compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(appRoot),
      registry: createTestRegistry({
        definition,
        templates: [
          {
            exportName: "template",
            reference: { snapshotId: "snapshot_1" },
            template,
          },
        ],
      }),
    });

    const sandbox = access.get();
    await vi.waitFor(() => {
      expect(mocks.waitForDevelopmentSandboxPrewarm).toHaveBeenCalled();
    });
    expect(definition).not.toHaveBeenCalled();

    waiting.resolve();
    await sandbox;
    expect(definition).toHaveBeenCalledTimes(1);
  });

  it("rejects definitions that return an ordinary session instead of a durable sandbox", async () => {
    const access = await ensure({
      registry: createTestRegistry({
        definition: () => mockSandbox().session as Sandbox,
      }),
    });

    await expect(access.get()).rejects.toThrow(/must return a durable Sandbox value/);
  });

  it("tracks custom provider sandboxes for process shutdown", async () => {
    const access = await ensure({
      registry: createTestRegistry({
        definition: () => createTestSandbox("custom-sandbox"),
      }),
    });

    await access.get();
    expect(countActiveSandboxHandles()).toBe(1);

    await shutdownActiveSandboxHandles();
    expect(shutdownTestSandbox).toHaveBeenCalledWith("custom-sandbox");
  });
});

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}
