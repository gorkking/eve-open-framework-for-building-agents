import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import { withVirtualContextValue } from "#context/virtual-scope.js";

const TestScopeKey = new ContextKey<string>("eve.testVirtualScope");

describe("withVirtualContextValue", () => {
  it("uses the unified context and restores a nested value", async () => {
    const context = new ContextContainer();
    context.setVirtualContext(TestScopeKey, "outer");

    await contextStorage.run(context, async () => {
      await withVirtualContextValue(TestScopeKey, "inner", async () => {
        expect(contextStorage.getStore()?.get(TestScopeKey)).toBe("inner");
      });
      expect(context.get(TestScopeKey)).toBe("outer");
    });
  });

  it("removes a new value after failure", async () => {
    const context = new ContextContainer();

    await expect(
      contextStorage.run(context, async () => {
        await withVirtualContextValue(TestScopeKey, "temporary", () => {
          throw new Error("failed");
        });
      }),
    ).rejects.toThrow("failed");

    expect(context.has(TestScopeKey)).toBe(false);
  });

  it("creates one unified context when called outside an active scope", async () => {
    await withVirtualContextValue(TestScopeKey, "standalone", async () => {
      expect(contextStorage.getStore()?.get(TestScopeKey)).toBe("standalone");
    });

    expect(contextStorage.getStore()).toBeUndefined();
  });
});
