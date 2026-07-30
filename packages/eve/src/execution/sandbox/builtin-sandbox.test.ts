import { describe, expect, it, vi } from "vitest";

import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { withSandboxRuntimeCreationContext } from "#execution/sandbox/creation-context.js";
import type {
  SandboxEngine,
  SandboxEngineCreateInput,
  SandboxEngineHandle,
} from "#shared/sandbox-engine.js";
import { getSandboxAdapterType, restoreSandbox, serializeSandbox } from "#shared/sandbox-value.js";

const mocks = vi.hoisted(() => ({
  createJustBashSandboxEngine: vi.fn(),
}));

vi.mock("#execution/sandbox/bindings/local.js", () => ({
  createDockerSandboxEngine: vi.fn(),
  createJustBashSandboxEngine: mocks.createJustBashSandboxEngine,
  createMicrosandboxSandboxEngine: vi.fn(),
}));
vi.mock("#execution/sandbox/bindings/vercel.js", () => ({
  createVercelSandbox: vi.fn(),
}));

import { createBuiltinSandbox } from "#execution/sandbox/builtin-sandbox.js";

describe("built-in durable sandbox adapter", () => {
  it("uses a distinct durable protocol identity for each built-in provider", async () => {
    const create = async (provider: "docker" | "vercel") =>
      await withSandboxRuntimeCreationContext(
        {
          appRoot: "/tmp/eve-app",
          sessionKey: `${provider}-session`,
          signal: new AbortController().signal,
        },
        async () =>
          await createBuiltinSandbox({
            engine: createEngine({
              configuration: {},
              metadata: {},
              provider,
              sessionKey: `${provider}-session`,
            }),
            provider,
            templateKey: null,
          }),
      );

    const [docker, vercel] = await Promise.all([create("docker"), create("vercel")]);

    expect(getSandboxAdapterType(docker)).toBe("eve/docker-sandbox");
    expect(getSandboxAdapterType(vercel)).toBe("eve/vercel-sandbox");
  });

  it("reconstructs the provider with its captured configuration and exact references", async () => {
    const initialEngine = createEngine({
      configuration: { autoInstall: false },
      metadata: { rootPath: "/tmp/eve-session-root" },
      provider: "just-bash",
      sessionKey: "provider-session-key",
    });
    const restoredEngine = createEngine({
      configuration: { autoInstall: false },
      metadata: { rootPath: "/tmp/eve-session-root" },
      provider: "just-bash",
      sessionKey: "provider-session-key",
    });
    mocks.createJustBashSandboxEngine.mockReturnValue(restoredEngine);

    const sandbox = await withSandboxRuntimeCreationContext(
      {
        appRoot: "/tmp/eve-app",
        sessionKey: "framework-session-key",
        signal: new AbortController().signal,
      },
      async () =>
        await createBuiltinSandbox({
          engine: initialEngine,
          provider: "just-bash",
          templateKey: "template-key",
          templateReference: { image: "template-reference" },
        }),
    );
    const serialized = await serializeSandbox(sandbox);

    const restored = restoreSandbox(serialized);
    await restored.run({ command: "true" });

    expect(mocks.createJustBashSandboxEngine).toHaveBeenCalledWith({
      createOptions: { autoInstall: false },
    });
    expect(restoredEngine.create).toHaveBeenCalledWith({
      context: { appRoot: "/tmp/eve-app" },
      existingMetadata: { rootPath: "/tmp/eve-session-root" },
      sessionKey: "provider-session-key",
      signal: undefined,
      tags: undefined,
      templateKey: "template-key",
      templateReference: { image: "template-reference" },
    });
  });
});

function createEngine(
  state: Awaited<ReturnType<SandboxEngineHandle["captureState"]>>,
): SandboxEngine & { readonly create: ReturnType<typeof vi.fn> } {
  const handle = {
    captureState: vi.fn(async () => state),
    session: mockSandbox({ id: state.sessionKey }).session,
    shutdown: vi.fn(async () => {}),
  } satisfies SandboxEngineHandle;
  return {
    provider: state.provider,
    create: vi.fn(async (_input: SandboxEngineCreateInput) => handle),
    prepare: vi.fn(),
  };
}
