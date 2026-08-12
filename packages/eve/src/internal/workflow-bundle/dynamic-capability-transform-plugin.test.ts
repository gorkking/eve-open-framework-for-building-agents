import { describe, expect, it } from "vitest";

import { createDynamicCapabilityTransformPlugin } from "./dynamic-capability-transform-plugin.js";

describe("dynamic capability transform plugin", () => {
  it("transforms defineDynamic tools outside the tools directory", async () => {
    const plugin = createDynamicCapabilityTransformPlugin();
    const result = await plugin.transform(
      `
        export default defineDynamic({
          events: {
            "turn.started": async () => {
              return {
                save: defineTool({
                  description: "Save",
                  inputSchema: { type: "object" },
                  execute() { return "saved"; },
                }),
              };
            },
          },
        });
      `,
      "/agent/lib/provider.ts",
    );

    expect(result?.code).toContain("__executeStepFn");
    await expect(plugin.transform(result!.code, "/agent/lib/provider.ts")).resolves.toBeNull();
  });
});
