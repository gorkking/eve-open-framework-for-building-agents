import { describe, expect, it } from "vitest";

import {
  APPLICATION_BUILD_PROFILE_SCHEMA_VERSION,
  ApplicationBuildProfiler,
  createApplicationBuildProfile,
} from "./build-profile.js";

describe("ApplicationBuildProfiler", () => {
  it("records rounded phase timings and one total duration", async () => {
    let now = 100;
    const profiler = new ApplicationBuildProfiler({ now: () => now });

    await profiler.measure("host.prepare", async () => {
      now = 123.456;
    });
    await profiler.measure("nitro.all.bundle", () => {
      now = 200;
    });

    expect(profiler.finish()).toEqual({
      durationMs: 100,
      nitro: {
        chunks: 0,
        groups: [],
        invocations: 0,
        largestModules: [],
        moduleOccurrences: 0,
        renderedLength: 0,
        uniqueModules: 0,
      },
      phases: [
        { durationMs: 23.5, name: "host.prepare" },
        { durationMs: 76.5, name: "nitro.all.bundle" },
      ],
      rolldown: {
        categories: [],
        invocations: 0,
        moduleOccurrences: 0,
        totalInvocationDurationMs: 0,
        uniqueModules: 0,
      },
    });
  });

  it("keeps failed phase timing for callers that handle an error", async () => {
    let now = 10;
    const profiler = new ApplicationBuildProfiler({ now: () => now });

    await expect(
      profiler.measure("nitro.all.bundle", () => {
        now = 25;
        throw new Error("bundle failed");
      }),
    ).rejects.toThrow("bundle failed");

    expect(profiler.finish()).toEqual({
      durationMs: 15,
      nitro: {
        chunks: 0,
        groups: [],
        invocations: 0,
        largestModules: [],
        moduleOccurrences: 0,
        renderedLength: 0,
        uniqueModules: 0,
      },
      phases: [{ durationMs: 15, name: "nitro.all.bundle" }],
      rolldown: {
        categories: [],
        invocations: 0,
        moduleOccurrences: 0,
        totalInvocationDurationMs: 0,
        uniqueModules: 0,
      },
    });
  });
});

describe("createApplicationBuildProfile", () => {
  it("creates a versioned, machine-readable profile", () => {
    expect(
      createApplicationBuildProfile({
        output: {
          files: 3,
          functionBundles: [
            { files: 2, gzipBytes: 18, path: "functions/eve/__server.func", rawBytes: 42 },
          ],
          gzipBytes: 27,
          rawBytes: 64,
        },
        target: "vercel",
        timing: {
          durationMs: 125.4,
          nitro: {
            chunks: 2,
            groups: [
              {
                group: "eve:runtime",
                moduleOccurrences: 2,
                renderedLength: 42,
                uniqueModules: 2,
              },
            ],
            invocations: 1,
            largestModules: [{ id: "eve:runtime/session.js", renderedLength: 30 }],
            moduleOccurrences: 2,
            renderedLength: 42,
            uniqueModules: 2,
          },
          phases: [{ durationMs: 100, name: "nitro.flow.bundle" }],
          rolldown: {
            categories: [],
            invocations: 0,
            moduleOccurrences: 0,
            totalInvocationDurationMs: 0,
            uniqueModules: 0,
          },
        },
      }),
    ).toEqual({
      durationMs: 125.4,
      kind: "eve-build-profile",
      nitro: {
        chunks: 2,
        groups: [
          {
            group: "eve:runtime",
            moduleOccurrences: 2,
            renderedLength: 42,
            uniqueModules: 2,
          },
        ],
        invocations: 1,
        largestModules: [{ id: "eve:runtime/session.js", renderedLength: 30 }],
        moduleOccurrences: 2,
        renderedLength: 42,
        uniqueModules: 2,
      },
      output: {
        files: 3,
        functionBundles: [
          { files: 2, gzipBytes: 18, path: "functions/eve/__server.func", rawBytes: 42 },
        ],
        gzipBytes: 27,
        rawBytes: 64,
      },
      phases: [{ durationMs: 100, name: "nitro.flow.bundle" }],
      rolldown: {
        categories: [],
        invocations: 0,
        moduleOccurrences: 0,
        totalInvocationDurationMs: 0,
        uniqueModules: 0,
      },
      schemaVersion: APPLICATION_BUILD_PROFILE_SCHEMA_VERSION,
      target: "vercel",
    });
  });
});
