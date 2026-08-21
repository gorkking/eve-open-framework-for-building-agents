---
issue: TBD
status: proposed
last_updated: "2026-08-21"
---

# Agent layers: internal programmatic registration

## Decision

Introduce one internal registration mechanism — the **agent layer** — through
which the framework contributes its built-in features to an agent. A layer is
an in-memory, agent-shaped set of definitions authored with the same public
primitives users write in files (`defineTool`, `defineDynamic`,
`defineChannel`, `defineSandbox`), compiled by the same normalizers, and
resolved by the same runtime resolvers. Framework defaults stop being
special-cased code paths; they become entries in a layer composed with the
authored manifest at load time.

This is the foundation for building eve with eve: framework features are
expressed as eve primitives, and the only framework privilege is layer
precedence.

## Problem

The authored pipeline is single-tracked: discover → compile
(`CompiledAgentManifest` + module map) → resolve (`resolve-*.ts` →
`RuntimeRegistry`) → execution/harness. Framework features bypass all of it,
and each invents its own entry point:

- `connection_search` fabricates file identity
  (`logicalPath: "eve:framework/connection-search-dynamic"`, `slug:
"connection"`, `sourceKind: "module"` with no module behind it) and is
  spliced onto `dynamicToolResolvers` during graph resolution.
- Static framework tools live in hardcoded arrays
  (`runtime/framework-tools/index.ts`) merged by ad-hoc filters;
  `load_skill` is rebuilt per node via a closure swap; `web_search` is an
  execute-less sentinel detected by the absence of `execute`; `agent` and
  `task_*` are execute-less registry stubs that exist "so `disableTool`
  validates" while the harness injects the real definitions late.
- The default `eve` channel calls the public `eveChannel()` builder at
  runtime, force-casts the result, and hand-rolls
  `ResolvedChannelDefinition`s. Three more channel families (connection
  callback, session callback, task input) each do the same with their own
  naming convention.
- The default sandbox and framework channel adapters are registry fallbacks
  with yet more bespoke provenance strings.

Systemic costs:

- The shadow/disable merge grammar is implemented three times for channels
  (graph resolution, the Nitro route registry, agent-info) and separately
  again for tools.
- Four competing fake-provenance conventions exist
  (`eve:framework/...`, `framework://channels/...`, `eve:framework:...`,
  `eve:bash-tool`).
- Framework-ness is detected by string sniffing
  (`sourceId.startsWith("eve:")` in `execution/node-step.ts`), which decides
  real behavior (auth wrapping).
- `runtime/resolve-channel.ts` documents that framework channels "do not flow
  through this resolver" — the framework cannot use its own pipeline.

The seams for a fix already exist: `compileFromMemory` proves a manifest and
module map can be built without a filesystem; the module map is just
`nodes[nodeId].modules[sourceId] → module-namespace object`, so live
definitions can be injected as `{ default: definition }`; and all runtime
consumers funnel through `loadFullBundle` → `resolveRuntimeAgentGraph`.

## Authoring API (internal)

The framework layer lives in a source directory that mirrors an agent tree,
with one definition per file and names derived from the layer record keys —
the in-memory analog of deriving names from file paths:

```ts
// src/framework/layer.ts (internal; never a public export)
export const frameworkLayer = defineAgentLayer({
  id: "framework",
  tools: {
    ask_question: askQuestionTool, // defineTool(...)
    bash: bashTool,
    read_file: readFileTool,
    write_file: writeFileTool,
    todo: todoTool,
    web_fetch: webFetchTool,
    connection: connectionSearchDynamic, // defineDynamic(...)
    load_skill: nodeScoped((node) => createSkillTool(node.skills)),
    glob: optIn(globTool),
    grep: optIn(grepTool),
    web_search: advertisedStub(webSearchStub),
    agent: advertisedStub(agentToolStub),
    task_cancel: advertisedStub(taskCancelStub),
    task_update: advertisedStub(taskUpdateStub),
  },
  channels: {
    eve: eveChannel({ auth: [vercelOidc(), localDev(), placeholderAuth()] }),
    "eve/v1/callback": sessionCallbackChannel(),
    "eve/v1/connections/callback": connectionCallbackChannel(),
    "eve/v1/task-input": taskInputResponseChannel(),
  },
  sandbox: defaultSandbox(),
  adapters: [httpAdapter, subagentAdapter, scheduleAdapter],
});
```

- Slot record values are ordinary public definitions. `defineTool` and
  `defineDynamic` share the `tools` slot exactly as authored
  `agent/tools/*.ts` files do.
- Three small combinators cover the cases where a plain definition cannot:
  - `nodeScoped(factory)` — the definition depends on the resolved node's
    resources (today: `load_skill` embeds the node's skill list). The factory
    runs once per node during composition.
  - `optIn(definition)` — registered for name validation and agent-info
    status only; the definition reaches the model only when an author mounts
    it as a file (unchanged `glob`/`grep`/`eve/tools` behavior).
  - `advertisedStub(meta)` — name, schema, and description registration for
    tools whose execution the harness owns (`web_search` provider swap,
    late-injected `agent`/`task_*`). The stub declares that interception
    exists instead of the current implicit "no execute means the harness will
    deal with it".
- Callback channel families are rewritten as real `defineChannel` values with
  one channel per family carrying its GET/POST routes, replacing today's
  per-method hand-built definitions and per-method channel names.

## Compilation and provenance

`compileAgentLayer(layer)` reuses the existing per-primitive normalizers and
is synchronous (definitions are already live objects — no filesystem, no
bundler):

```ts
interface CompiledAgentLayer {
  readonly id: string;
  readonly resources: CompiledLayerResources; // compiled entries per slot
  readonly modules: Record<string, Record<string, unknown>>; // sourceId → { default: definition }
  readonly knownNames: CompiledLayerKnownNames; // per slot, incl. opt-in and stubs
}
```

One provenance convention replaces the current four:

- `sourceId` and `logicalPath` are `eve:<layerId>/<slot>/<name>`
  (e.g. `eve:framework/tools/bash`, `eve:framework/channels/eve`).
- `eve:` becomes a reserved sourceId scheme; composition rejects any authored
  entry claiming it.
- Compiled and resolved definitions gain an explicit
  `origin: "framework" | "authored" | "extension"` field. All behavior that
  currently sniffs `sourceId.startsWith("eve:")` (auth wrapping, agent-info
  status, TUI presentation) switches to `origin`. Authored entries default to
  `"authored"`, so serialized artifacts change only by the manifest version
  bump that adds the field.

## Composition semantics

`composeAgentNodeResources({ layers, node })` is the single implementation of
the merge grammar, applied per node:

- Layers are ordered; the authored node is always the last layer. A later
  entry shadows an earlier entry with the same (slot, name).
- `disableTool()` / `disableRoute()` sentinels in a later layer remove the
  earlier entry with that name. Disabling a name that no earlier layer knows
  (including opt-in and stub names) is an authoring error with the existing
  error text listing valid names.
- Name collisions inside one layer are errors, as today.
- The function returns the merged resources, the merged module namespaces,
  and a composition report (which entries were shadowed, disabled, opt-in) so
  agent-info renders status from the report instead of re-deriving it.

```text
compiled framework layer ─┐
                          ├─ composeAgentNodeResources ─→ merged node resources
authored node manifest ───┘         │                       + module namespaces
                                    └─ report (shadowed / disabled / opt-in)
```

Composition happens at load time, never in serialized artifacts:

- **Runtime**: `loadFullBundle` composes every node and augments the module
  map before `resolveRuntimeAgentGraph`. Graph resolution loses all framework
  imports; framework channels flow through `resolve-channel.ts`, framework
  tools through `resolve-tool.ts`, and `connection_search` through the
  standard compiled dynamic-tool path. The resolver splice and the
  hand-rolled `ResolvedChannelDefinition`s are deleted.
- **Nitro build**: the application route registry composes
  `manifest.channels` with the compiled layer's channel entries through the
  same function to emit virtual handlers, replacing its private copy of the
  merge logic.
- **agent-info**: both builders consume the composition report and `origin`.

Because the layer is compiled from the running eve version at load, framework
defaults can never skew against the installed framework, and `.eve` artifacts
remain purely authored.

## Scope

Phase 1 migrates the definition-shaped defaults onto the layer:

1. Channels: default `eve` channel plus the three callback families
   (deletes `runtime/framework-channels/index.ts` and the triplicated merge).
2. `connection_search` as a `defineDynamic` layer entry
   (deletes the fabricated identity and the graph-resolution splice).
3. Static tools, `nodeScoped` `load_skill`, `optIn` `glob`/`grep`, and
   `advertisedStub` entries for `web_search`/`agent`/`task_*`
   (deletes the hardcoded arrays and the closure swap; `origin` replaces
   prefix sniffing).
4. Default sandbox and framework channel adapters as layer slots
   (deletes the registry fallback special cases).

### Non-goals

- Harness-level interception stays where it is: `final_output`, the
  `Workflow` tool, the `web_search` provider swap, and the session-shape
  gating and late injection of `agent`/`task_*`. Only their _registration_
  (names, schemas, disable validation, agent-info) moves to the layer.
  Converting them to framework dynamic resolvers is follow-up work.
- The durable dynamic-tool callback registry is a durability mechanism, not a
  registration mechanism, and is unchanged.
- The owner-scoped runtime tool contribution seam (#2347) is complementary:
  the layer owns static registration at load; #2347 governs runtime code
  contributing tool sets mid-session. `connection_search`'s definition
  registers through the layer either way.
- Extension composition is untouched, but the design anticipates it:
  extensions can become layers ordered between the framework layer and the
  authored node (`origin: "extension"`), replacing compile-time composition
  in a follow-up.
- No public API changes. `defineAgentLayer` is internal.

### Behavior changes

- Callback channel families consolidate to one channel name per family
  (`eve/v1/callback` instead of per-method names), which changes the file
  names that `disableRoute()` matches for those internal channels.
  Intentional pre-1.0 cleanup; the `eve` channel name is unchanged.
- agent-info gains `origin` and report-derived statuses; existing fields keep
  their values.

## Validation

- Unit: composition grammar — shadowing, disable, unknown-disable error text,
  intra-layer collisions, reserved `eve:` scheme rejection, `nodeScoped`
  per-node evaluation, report contents.
- Integration: `loadFullBundle` parity — for a representative agent, the
  merged bundle exposes the same tool names, channel routes, sandbox, and
  adapters as today, and framework entries resolve through the standard
  resolvers.
- Scenario: Nitro route table unchanged for a fixture app; boot and dispatch
  through the default `eve` channel.
- E2E: existing eve-channel and built-in tool evals cover the golden paths;
  agent-info eval asserts `origin` and statuses.
- Each migration phase must be observably behavior-preserving (same names,
  routes, error messages, agent-info output) apart from the changes listed
  above.

## Invariants

- Serialized `.eve` artifacts contain only authored entries; layer
  composition is deterministic and happens at load.
- Every model-visible or host-visible name — tool, channel, adapter kind,
  sandbox — enters through exactly one composition path with a single
  shadow/disable rule.
- Framework provenance uses exactly one scheme, `eve:<layerId>/<slot>/<name>`,
  and `eve:` is reserved against authored entries.
- Framework-ness is carried by `origin`, never derived from string prefixes.
- Framework definitions are authored with public primitives; `resolve-*.ts`
  contains no framework-specific branches.
- The layer registers and advertises; any harness-owned interception is
  declared explicitly via `advertisedStub`, never implied by a missing
  `execute`.
