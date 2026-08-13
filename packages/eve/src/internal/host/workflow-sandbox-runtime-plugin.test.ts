import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApplicationLifecycle } from "#internal/host/application-lifecycle.js";

const codeModeMocks = vi.hoisted(() => ({
  continueCodeModeInterrupt: vi.fn(),
  createCodeModeTool: vi.fn(),
  getCodeModeInterrupt: vi.fn(),
  requestCodeModeInterrupt: vi.fn(),
  unwrapCodeModeResult: vi.fn(),
}));

const sandboxMocks = vi.hoisted(() => ({
  installWorkflowSandboxModule: vi.fn(),
}));

vi.mock("#compiled/experimental-ai-sdk-code-mode/index.js", () => codeModeMocks);
vi.mock("#shared/workflow-sandbox.js", () => sandboxMocks);

describe("installWorkflowSandboxRuntimePlugin", () => {
  beforeEach(() => {
    vi.resetModules();
    sandboxMocks.installWorkflowSandboxModule.mockReset();
  });

  it("installs code mode on import and accepts the eve application lifecycle", async () => {
    const plugin = (await import("#internal/host/workflow-sandbox-runtime-plugin.js")) as {
      default: (lifecycle: ApplicationLifecycle) => void;
    };

    expect(sandboxMocks.installWorkflowSandboxModule).toHaveBeenCalledWith(codeModeMocks);
    expect(plugin.default(new ApplicationLifecycle())).toBeUndefined();
  });
});
