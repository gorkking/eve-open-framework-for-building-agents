import { describe, expect, it } from "vitest";

import {
  EveRolldownBuildProfiler,
  profileEveRolldownBuild,
  runWithEveRolldownBuildProfiler,
} from "./build-profile.js";

describe("EveRolldownBuildProfiler", () => {
  it("aggregates invocations and shared modules by category", () => {
    const profiler = new EveRolldownBuildProfiler();

    profiler.record("authored-module", 10.04, ["entry-a", "shared"]);
    profiler.record("authored-module", 20.08, ["entry-b", "shared"]);
    profiler.record("workflow-final", 5, ["shared", "workflow"]);

    expect(profiler.finish()).toEqual({
      categories: [
        {
          category: "authored-module",
          invocations: 2,
          moduleOccurrences: 4,
          totalInvocationDurationMs: 30.1,
          uniqueModules: 3,
        },
        {
          category: "workflow-final",
          invocations: 1,
          moduleOccurrences: 2,
          totalInvocationDurationMs: 5,
          uniqueModules: 2,
        },
      ],
      invocations: 3,
      moduleOccurrences: 6,
      totalInvocationDurationMs: 35.1,
      uniqueModules: 4,
    });
  });

  it("keeps concurrent build profiles isolated through async work", async () => {
    const first = new EveRolldownBuildProfiler();
    const second = new EveRolldownBuildProfiler();

    await Promise.all([
      runWithEveRolldownBuildProfiler(first, () =>
        profileEveRolldownBuild(
          "authored-module",
          async () => ({ modules: ["first"] }),
          (result) => result.modules,
        ),
      ),
      runWithEveRolldownBuildProfiler(second, () =>
        profileEveRolldownBuild(
          "workflow-steps",
          async () => ({ modules: ["second"] }),
          (result) => result.modules,
        ),
      ),
    ]);

    expect(first.finish()).toMatchObject({
      categories: [{ category: "authored-module", invocations: 1 }],
      invocations: 1,
      uniqueModules: 1,
    });
    expect(second.finish()).toMatchObject({
      categories: [{ category: "workflow-steps", invocations: 1 }],
      invocations: 1,
      uniqueModules: 1,
    });
  });
});
