---
issue: "n/a"
status: proposed
last_updated: "2026-08-21"
---

# Framework feature registration

## Problem

eve primitives enter the runtime through one pipeline: discover files under
`agent/`, compile them into a manifest plus module map, hydrate live
definitions, and merge them into registries. Framework internals have no way to
enter that pipeline, because they have no filesystem home and there is no
programmatic registration API. Each built-in therefore invents its own way in:

| Built-in                                            | Today                                                                       | The invention                                                                                                                                                                                                                                        |
| --------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default tools (`bash`, `todo`, …)                   | Static arrays in `runtime/framework-tools/index.ts`                         | Synthetic `logicalPath: "eve:framework/bash"`; three parallel lists (registered / opt-in / known-for-validation)                                                                                                                                     |
| eve channel                                         | `getFrameworkChannelDefinitions()` in `runtime/framework-channels/index.ts` | Instantiates a real `CompiledChannel`, then hand-decomposes it into per-route definitions with fake `framework://channels/…` paths                                                                                                                   |
| Connection, session, and task-input callback routes | Three bespoke builder modules                                               | Build raw `ResolvedChannelDefinition` objects by hand; never touch `defineChannel`                                                                                                                                                                   |
| `connection_search`                                 | Fourth list: `REGISTERED_FRAMEWORK_DYNAMIC_TOOLS`                           | Reuses the authored `defineDynamic` contract with a fake slug; re-derives its discovered tools by scanning message history every step (`extractDiscoveredTools`) merged with a side context key, because resolvers own no durable state of their own |
| Implicit `agent` and task tools                     | Injection in `execution/node-step.ts`                                       | Availability predicates duplicated across modules; framework provenance detected by `sourceId.startsWith("eve:")`                                                                                                                                    |

Consequences: adding a built-in touches four to six places; override/disable
merge semantics are duplicated inline per primitive in
`runtime/resolve-agent-graph.ts`; provenance is fabricated everywhere; and
nothing composes — a feature cannot be expressed as a bundle of the same
primitives authors use. This is the direct blocker for building more of eve
with eve.

## Decision

Introduce one internal concept — the **framework feature** — and make it the
only way framework-owned primitives enter the runtime graph. A feature declares,
colocated with its implementation, the primitives it contributes using the exact
shapes the authored pipeline produces, plus its gating and sentinel-disable
semantics. A static catalog of features replaces every parallel list; one
resolver evaluates the catalog once per graph node; one merge function applies
authored-overrides-framework semantics for all primitive kinds.

Framework code never writes compiled artifacts and never fakes module
provenance going forward: framework contributions carry an explicit framework
source ref.

### Feature API

```ts
// src/runtime/framework/types.ts
export interface FrameworkFeature {
  /** Stable id, e.g. "eve.tools.bash", "eve.channels.eve", "eve.connection-search". */
  readonly id: string;

  /** Which sentinel removes this feature: disableTool(name) or disableRoute(name). */
  readonly kind: "tools" | "routes";
  /** Contributed names validated against sentinels, e.g. ["bash"] or ["eve"]. */
  readonly names: readonly string[];

  /** Cheap gate evaluated once per graph-node resolution. */
  readonly isAvailable?: (input: FrameworkGateContext) => boolean;

  /** Contributions in authored-resolved shapes. Called only when available. */
  readonly resolve: (input: { agent: ResolvedAgent }) => FrameworkContributions;
}

export interface FrameworkContributions {
  /** Registered in the tool registry alongside authored tools. */
  readonly tools?: readonly ResolvedToolDefinition[];
  /** Real defineChannel values; expanded to routes by one shared helper. */
  readonly channels?: readonly FrameworkChannelContribution[];
  /** Registered alongside authored dynamic-tool resolvers. */
  readonly dynamicTools?: readonly FrameworkDynamicToolContribution[];
  /** Materialized at the harness layer (delegation-shaped tools). */
  readonly delegationTools?: readonly FrameworkDelegationToolContribution[];
}
```

A `FrameworkChannelContribution` is `{ name, channel }` where `channel` is a
live `CompiledChannel` from `defineChannel`. A
`FrameworkDynamicToolContribution` is `{ slug, definition }` where `definition`
is a `defineDynamic` value — the same contract authored dynamic tools use. A
`FrameworkDelegationToolContribution` declares `{ name, when(config), create() }`
where `create` produces the harness definition given `{ nodeId, tasksEnabled }`;
the exact harness shapes (`delegation` vs `background`) remain owned by the
harness layer.

### Catalog and resolution

The catalog is a plain static array — no mutable global registry, no
import-order hazards across Nitro chunks:

```ts
// src/runtime/framework/features/index.ts
export const FRAMEWORK_FEATURES: readonly FrameworkFeature[] = [
  bashTool,
  readFileTool,
  writeFileTool,
  webFetchTool,
  webSearchTool,
  todoTool,
  askQuestionTool,
  skillTool,
  globTool,
  grepTool,
  agentTool,
  taskTools,
  eveChannel,
  connectionCallbackRoutes,
  sessionCallbackRoutes,
  taskInputResponseRoutes,
  connectionSearch,
];
```

Each feature lives beside its implementation (`features/bash.ts` exports the
tool definition and wraps it). Catalog order defines merge order;
feature-vs-feature name collisions throw at module init.

```ts
// src/runtime/framework/resolve-framework-features.ts
export function resolveFrameworkFeatures(input: {
  agent: ResolvedAgent;
}): ResolvedFrameworkFeatures;
```

evaluates `isAvailable` gates once per node, calls `resolve({ agent })` on
survivors, validates every sentinel target up-front (preserving today's exact
error messages), and returns the flattened contributions.

`runtime/resolve-agent-graph.ts` becomes the single consumer:

```ts
const framework = resolveFrameworkFeatures({ agent });
const tools = mergeTools({
  framework: framework.tools,
  authored: agent.tools,
  disabled: agent.disabledFrameworkTools,
});
const channels = mergeChannels({
  framework: expandFrameworkChannels(framework.channels),
  authored: agent.channels,
  disabled: agent.disabledFrameworkChannels,
});
```

`mergeTools` and `mergeChannels` implement the existing semantics exactly once:
authored same-name overrides framework, disable sentinels remove, unknown
sentinel names error loudly, registry duplicate guards still cover
authored-vs-authored collisions.

## Pipeline position

```
authored:    agent/**  ─▶ discover ─▶ compile (manifest + module map) ─▶ hydrate (resolveAgent) ─┐
                                                                                                  ├─▶ merge ─▶ registries ─▶ node
framework:  FRAMEWORK_FEATURES ─▶ resolveFrameworkFeatures (gates + sentinel validation) ──────────┘
                                        │
                                        └─▶ channels expanded by the shared CompiledChannel expander
                                            (also used by the authored hydration path)
```

Authored and framework primitives meet only inside `merge`. Downstream
consumers (registries, dispatch, advertised-tools) cannot tell them apart
except by source ref.

## Migration map

| Today                                                                                   | Becomes                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REGISTERED_FRAMEWORK_TOOLS`, `OPT_IN_FRAMEWORK_TOOLS`, `ALL_FRAMEWORK_TOOLS` + getters | Per-feature declarations; availability expressed as `isAvailable` or opt-in membership; known-name validation derives from the catalog (delegation names included)                        |
| Hand-rolled route flattening in `framework-channels/index.ts`                           | Shared `expandCompiledChannelRoutes({ name, channel, source })` used by both the framework path and `runtime/resolve-channel.ts`                                                          |
| `getConnectionCallbackChannelDefinitions`, session callback, task-input builders        | Four small `defineChannel` features preserving current route paths, methods, auth-exempt behavior, and the pinned `[vercelOidc(), localDev(), placeholderAuth()]` walk on the eve channel |
| `extractDiscoveredTools` + `ConnectionSearchResultsKey` duality                         | Single explicit durable session-scope results key owned by the connection-search feature (see below)                                                                                      |
| Predicates + injection blocks in `node-step.ts` for `agent`/task tools                  | Generic iteration over resolved `delegationTools`; root-only visibility stays in advertised-tools (session shape, correctly placed)                                                       |
| `sourceId.startsWith("eve:")` provenance sniffing                                       | `sourceKind: "framework"` on a dedicated framework source ref (`sourceId: "eve:<feature-id>"`); runtime resolved types accept it; compiler manifest schemas are untouched                 |

## connection_search state ownership

Today discovered tools survive through two redundant sources: a durable context
key (`ConnectionSearchResultsKey`, written via `ctx.set` and therefore
serialized) and message-history scraping. The step handler merges both on every
step. The plan makes the durable key the single source of truth, scoped to the
session, owned explicitly by the feature:

- Search execution writes results to the key (as today).
- The `step.started` handler reads the key, rebuilds qualified-name entries from
  stored metadata, and returns the full set — no message parsing.
- `extractDiscoveredTools` is deleted.

Observable change: discovered tools previously vanished when compaction removed
the supporting history _if_ the context key was also lost (for example across a
pre-key deployment). With a single durable source they persist for the session
regardless of compaction, which matches the dominant behavior today and makes it
deterministic. Park/resume and crash-recovery semantics are unchanged: the key
rides the existing durable-context serialization.

Durable-callback replay machinery (`stampDurableDynamicToolCallbacks`,
registration on resolve, lookup on replay) is untouched.

## Externally observable semantics

Unchanged:

- Default and opt-in tool sets per agent; `disableTool()` / `disableRoute()`
  behavior and error text.
- The eve channel's routes, auth walk, CORS, and turn policy.
- Callback route paths, methods, and payloads.
- The `connection_search` tool contract: input/output schemas, qualified
  `<connection>__<tool>` names, OAuth challenge flow, approval gating.
- Prompt composition, including the connections prompt section.

Changed:

- Discovered connection tools persist across compaction for the session (see
  above); docs that describe the compaction-driven expiry need a one-line
  update.
- Dev dashboard and observability surfaces may render
  `sourceKind: "framework"` instead of module-shaped provenance for built-ins.

## Invariants

1. Framework features never touch discovery, compilation artifacts, or module
   maps. There is exactly one entry point into graph assembly:
   `resolveFrameworkFeatures`.
2. Every name a feature contributes is sentinel-addressable; the known-name
   sets for `disableTool` / `disableRoute` validation derive from the catalog,
   so the lists can never drift apart again.
3. Feature `resolve` functions are pure over their input; side effects happen
   only later at established lifecycle points (dynamic-tool events, tool
   execute, route handlers).
4. Authored primitives always win name collisions against framework ones;
   framework-vs-framework collisions are a startup error, not a silent
   overwrite.
5. No public API surface changes: everything above is internal to the eve
   package.

## Out of scope

- Migrating extension contributions (`agent/extensions/*`) onto this mechanism.
  Their mount-file declaration and `<ns>__` namespacing continue to work; a
  follow-up can bridge extensions to the same contribution shapes.
- Public registration APIs for packages outside the repo.
- New contribution kinds beyond tools, channels, dynamic tools, and delegation
  tools. Schedules, hooks, sandboxes, and subagents have no framework-provided
  instances today; the contributions union can grow when one appears.
- Harness-layer concerns that are not registration: provider-managed
  `web_search` substitution and `ask_question` capability gating stay in the
  harness.

## Validation

- Unit tests for `resolveFrameworkFeatures` and the merge functions, porting
  the existing override/disable/unknown-sentinel/duplicate cases; move the
  pinned eve-channel auth-walk-order test.
- Update `context/dynamic-tool-lifecycle.test.ts` and connection-search tests
  that assert history-derived resurrection.
- Integration runs for graph resolution after the tools, channels, and
  connection-search migrations (tier configs, not bare vitest).
- Fixture evals in CI cover connection flows end to end; run the narrowest
  scenario test locally where channel or connection behavior changed.
- `pnpm fmt && pnpm lint && pnpm typecheck && pnpm guard:invariants` per phase;
  changeset (patch) on the published package.
