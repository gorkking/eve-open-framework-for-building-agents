import { performance } from "node:perf_hooks";

import { ContextContainer, contextStorage } from "#context/container.js";
import { ContextKey } from "#context/key.js";

/** Stable categories for Rolldown work initiated directly by eve. */
export type EveRolldownBuildCategory =
  | "authored-module"
  | "authored-module-map"
  | "workflow-final"
  | "workflow-intermediate"
  | "workflow-steps";

/** Aggregated measurements for one kind of eve-owned Rolldown build. */
export interface EveRolldownBuildCategoryProfile {
  readonly category: EveRolldownBuildCategory;
  readonly invocations: number;
  readonly moduleOccurrences: number;
  readonly totalInvocationDurationMs: number;
  readonly uniqueModules: number;
}

/** Aggregated measurements for all Rolldown builds initiated directly by eve. */
export interface EveRolldownBuildProfile {
  readonly categories: readonly EveRolldownBuildCategoryProfile[];
  readonly invocations: number;
  readonly moduleOccurrences: number;
  readonly totalInvocationDurationMs: number;
  readonly uniqueModules: number;
}

interface MutableCategoryProfile {
  invocations: number;
  moduleOccurrences: number;
  totalInvocationDurationMs: number;
  uniqueModules: Set<string>;
}

function roundDuration(durationMs: number): number {
  return Math.round(Math.max(0, durationMs) * 10) / 10;
}

function createMutableCategoryProfile(): MutableCategoryProfile {
  return {
    invocations: 0,
    moduleOccurrences: 0,
    totalInvocationDurationMs: 0,
    uniqueModules: new Set(),
  };
}

/** Collects build-local Rolldown measurements without threading state through bundler plugins. */
export class EveRolldownBuildProfiler {
  readonly #categories = new Map<EveRolldownBuildCategory, MutableCategoryProfile>();

  record(
    category: EveRolldownBuildCategory,
    durationMs: number,
    moduleIds: readonly string[],
  ): void {
    const profile = this.#categories.get(category) ?? createMutableCategoryProfile();
    profile.invocations += 1;
    profile.moduleOccurrences += moduleIds.length;
    profile.totalInvocationDurationMs += durationMs;
    for (const moduleId of moduleIds) profile.uniqueModules.add(moduleId);
    this.#categories.set(category, profile);
  }

  finish(): EveRolldownBuildProfile {
    const categories = [...this.#categories.entries()]
      .map(([category, profile]) => ({
        category,
        invocations: profile.invocations,
        moduleOccurrences: profile.moduleOccurrences,
        totalInvocationDurationMs: roundDuration(profile.totalInvocationDurationMs),
        uniqueModules: profile.uniqueModules.size,
      }))
      .sort((left, right) => left.category.localeCompare(right.category));
    const allUniqueModules = new Set<string>();
    let invocations = 0;
    let moduleOccurrences = 0;
    let totalInvocationDurationMs = 0;

    for (const profile of this.#categories.values()) {
      invocations += profile.invocations;
      moduleOccurrences += profile.moduleOccurrences;
      totalInvocationDurationMs += profile.totalInvocationDurationMs;
      for (const moduleId of profile.uniqueModules) allUniqueModules.add(moduleId);
    }

    return {
      categories,
      invocations,
      moduleOccurrences,
      totalInvocationDurationMs: roundDuration(totalInvocationDurationMs),
      uniqueModules: allUniqueModules.size,
    };
  }
}

const BUILD_PROFILER_CONTEXT_KEY = new ContextKey<EveRolldownBuildProfiler>(
  "eve.internal.build.rolldown-profiler",
);

/** Runs one application build with an isolated collector for concurrent bundler work. */
export function runWithEveRolldownBuildProfiler<T>(
  profiler: EveRolldownBuildProfiler,
  operation: () => T,
): T {
  const context = new ContextContainer();
  context.setVirtualContext(BUILD_PROFILER_CONTEXT_KEY, profiler);
  return contextStorage.run(context, operation);
}

/** Measures one eve-owned Rolldown invocation when build profiling is active. */
export async function profileEveRolldownBuild<T>(
  category: EveRolldownBuildCategory,
  operation: () => Promise<T>,
  getModuleIds: (result: T) => readonly string[],
): Promise<T> {
  const profiler = contextStorage.getStore()?.get(BUILD_PROFILER_CONTEXT_KEY);
  if (profiler === undefined) return await operation();

  const startedAt = performance.now();
  const result = await operation();
  profiler.record(category, performance.now() - startedAt, getModuleIds(result));
  return result;
}
