import { describe, expect, it, vi } from "vitest";

import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import type { JsonObject } from "#shared/json.js";
import {
  defineSandboxAdapter,
  isSandbox,
  restoreSandbox,
  serializeSandbox,
  shutdownSandbox,
} from "#shared/sandbox-value.js";

interface TestReference extends JsonObject {
  readonly id: string;
}

describe("defineSandboxAdapter", () => {
  it("serializes provider state and restores the handle lazily", async () => {
    const raw = mockSandbox({ id: "sandbox_1" });
    const restore = vi.fn(() => raw);
    const adapt = defineSandboxAdapter<ReturnType<typeof mockSandbox>, TestReference>({
      reference(sandbox) {
        return { id: sandbox.session.id };
      },
      restore,
      session(sandbox) {
        return sandbox.session;
      },
    });
    const sandbox = adapt(raw);

    expect(isSandbox(sandbox)).toBe(true);
    const serialized = await serializeSandbox(sandbox);
    expect(serialized).toMatchObject({
      id: "sandbox_1",
      reference: { id: "sandbox_1" },
    });

    const restored = restoreSandbox(serialized);
    expect(restored.id).toBe("sandbox_1");
    expect(restore).not.toHaveBeenCalled();

    await restored.run({ command: "echo restored" });
    expect(restore).toHaveBeenCalledOnce();
    expect(raw.commandLog).toEqual(["echo restored"]);
  });

  it("rejects non-JSON provider references at the durability boundary", async () => {
    const raw = mockSandbox();
    const adapt = defineSandboxAdapter<ReturnType<typeof mockSandbox>, TestReference>({
      reference() {
        return { invalid: new Date() } as never;
      },
      restore() {
        return raw;
      },
      session(sandbox) {
        return sandbox.session;
      },
    });

    await expect(serializeSandbox(adapt(raw))).rejects.toThrow(
      /Expected a JSON-serializable value/,
    );
  });

  it("runs provider shutdown at most once for one durable value", async () => {
    const raw = mockSandbox();
    const shutdown = vi.fn();
    const adapt = defineSandboxAdapter<ReturnType<typeof mockSandbox>, TestReference>({
      reference(sandbox) {
        return { id: sandbox.session.id };
      },
      restore() {
        return raw;
      },
      session(sandbox) {
        return sandbox.session;
      },
      shutdown,
    });
    const sandbox = adapt(raw);

    await Promise.all([shutdownSandbox(sandbox), shutdownSandbox(sandbox)]);
    expect(shutdown).toHaveBeenCalledOnce();
  });
});
