---
issue: https://github.com/vercel/eve/issues/2055
status: in-progress
last_updated: "2026-08-13"
---

# Direct build and routing system review

## Executive assessment

[PR #2056](https://github.com/vercel/eve/pull/2056) replaces Nitro with direct,
pinned Rolldown, H3, CrossWS, srvx, nf3, and Croner integration. The rewrite is
justified for eve's current Node and Vercel scope, but its benefits are narrower
than "everything is faster and simpler."

The strongest result is installation. In a local alternating warm-cache
benchmark, normal npm lock resolution fell from a 2.940 second median to 1.615
seconds, and installation fell from 3.670 seconds to 2.290 seconds. The
installed external package count fell from 33 to 21. These reductions come
primarily from removing unused storage, database, and cache packages and from
vendoring the env-runner implementation eve actually needs instead of
inheriting Nitro's surrounding development graph. Rolldown and its platform
bindings are still present.

The strongest architectural result is ownership. eve now has one explicit host
build configuration, one route registry, and explicit Node and Vercel adapters.
The old implementation reached into Nitro's build through configuration
mutation, build hooks, generated virtual modules, and a plugin-name patch. The
new code is easier to inspect and test at the boundaries eve actually changes.

This is not a demonstrated runtime-performance win. Nitro v3 already used
Rolldown, H3, CrossWS, and srvx. No comparable before-and-after build,
request-throughput, cold-start, or steady-state memory benchmark has been run.
The rewrite also moves platform responsibility into eve, including Vercel Build
Output, Node shutdown, WebSocket upgrades, schedules, and native dependency
tracing.

The recommendation is to keep the direct architecture and not return to the
current `nitro` umbrella package. Before the draft is merge-ready, automatic
native dependency classification and process-signal semantics need parity.
Vercel route syntax and Bun support need an explicit restore-or-break decision.

Nitro could become useful to eve again. The viable form is a set of small,
independently installable components that accept an already-defined eve
application and let eve own Rolldown. More public hooks in the existing package
would improve integration, but they would not solve dependency resolution.
That result requires a physical package split.

## Scope and evidence

This review compares the implementation before issue
[#2055](https://github.com/vercel/eve/issues/2055) with the draft implementation
in PR #2056.

The installation benchmark used:

- `eve@0.35.0` as the old artifact. Its runtime manifest matches the pre-change
  branch: `nitro@3.0.260610-beta` and `undici@8.9.0`.
- A packed PR artifact as the new artifact. It declares exact versions of
  Croner, CrossWS, H3, nf3, Rolldown, srvx, and Undici.
- Node 24.16.0, npm 11.13.0, pnpm 11.21.0, macOS 26.6, and Apple arm64.
- Fresh project directories with a shared pre-warmed cache. Old and new runs
  alternated order. Install scripts, audit, and funding requests were disabled.
- Eight npm `--package-lock-only` runs and six complete warm npm installs for
  each normal eve artifact.

The runtime dependency manifests were:

| Artifact     | Runtime dependencies                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------ |
| `eve@0.35.0` | `nitro@3.0.260610-beta`, `undici@8.9.0`                                                                            |
| PR #2056     | `croner@10.0.1`, `crossws@0.4.10`, `h3@2.0.1-rc.26`, `nf3@0.3.23`, `rolldown@1.2.3`, `srvx@0.12.5`, `undici@8.9.0` |

Top-level runtime declarations therefore grew from two to seven while the
resolved closure became smaller. Direct-dependency count alone is not a useful
measure of install cost.

The timings isolate package-manager metadata, constraint solving, and linking.
They do not measure registry latency. Empty-cache network measurements were
discarded because the observed 1.5 to 4.25 second network spread was larger than
the local operation being compared. Package counts and byte totals are more
portable than workstation timings.

The architectural review used current source and tests, the pre-change source
at the PR merge base, and Nitro's published and current upstream source. Nitro
v3 remains a beta; the latest published version reviewed here is
[`3.0.260610-beta`](https://github.com/nitrojs/nitro/releases/tag/v3.0.260610-beta),
released on June 10, 2026.

## Measured outcomes

### Normal eve installation

Normal npm behavior includes eve's peer dependency processing.

| Metric                                |      Nitro | Direct primitives | Change |
| ------------------------------------- | ---------: | ----------------: | -----: |
| External physical package directories |         33 |                21 |   -36% |
| Lockfile package entries              |         48 |                36 |   -25% |
| Lockfile bytes                        |     26,876 |            18,588 |   -31% |
| Total allocated disk, including eve   | 87,200 KiB |        80,236 KiB |  -8.0% |
| External logical bytes                | 38,882,149 |        34,570,089 | -11.1% |
| External allocated disk               | 47,372 KiB |        40,392 KiB | -14.7% |
| npm lock-only median                  |    2.940 s |           1.615 s | -45.1% |
| Warm npm install median               |    3.670 s |           2.290 s | -37.6% |

The lock-only ranges were narrow: 2.84 to 3.05 seconds with Nitro and 1.52 to
1.64 seconds with direct primitives. Five of the six complete Nitro installs
fell between 3.66 and 3.73 seconds; one unexplained 1.49 second outlier remains
in the raw sample but does not change the median. Direct installs ranged from
2.16 to 2.45 seconds.

### Runtime dependency closure

The runtime-only comparison excludes eve's peer graph and the tiny benchmark
wrapper package.

| Metric                                  |      Nitro | Direct primitives |    Change |
| --------------------------------------- | ---------: | ----------------: | --------: |
| External packages                       |         23 |                11 |      -52% |
| Lockfile package entries                |         37 |                25 |      -32% |
| Logical installed bytes                 | 25,404,392 |        21,092,434 |    -17.0% |
| Allocated `node_modules`                | 29,184 KiB |        22,204 KiB |    -23.9% |
| Dependency edges in installed manifests |         26 |                11 |      -58% |
| Optional peer edges                     |         43 |                 2 |      -95% |
| Rolldown platform bindings in the lock  |         14 |                14 | unchanged |

With peer auto-installation disabled, resolution was already short: npm
lock-only medians were 250 and 230 milliseconds, while pnpm medians were 260
and 250 milliseconds. The large normal-install difference is therefore mostly
the removed peer-constraint surface, not less JavaScript to download.
Runtime-only warm-install medians were 485 to 360 milliseconds with npm and
455 to 370 milliseconds with pnpm. The direction remains favorable, but the
absolute difference is much smaller when peer processing and network access
are removed.

The old optional-peer fan-out came principally from Nitro (8 edges), unstorage
(23), db0 (6), and env-runner (4). These declarations are reasonable for users
of those features, but eve did not use Nitro storage, database, or cache APIs.
It used the generic task runner only to implement eve schedules. The direct
graph retains only H3's CrossWS and CrossWS's srvx peer relationships.

The packed eve artifact itself did not become smaller:

| Metric                           |        Nitro | Direct primitives |
| -------------------------------- | -----------: | ----------------: |
| Compressed package tarball       |  7,988,954 B |       7,989,133 B |
| Logical unpacked package content | 29,729,967 B |      29,725,343 B |
| Published files                  |        3,182 |             3,188 |

The installation result comes from the dependency closure, not from reducing
eve's own published files.

### Performance claims the evidence does not support

| Area                               | Current conclusion                                                                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Dependency resolution              | Faster in the local benchmark, with a materially smaller manifest graph.                                                                  |
| Install size                       | Smaller dependency closure; eve's own tarball is unchanged.                                                                               |
| Application build time             | Likely less incidental work, but not benchmarked against the old implementation.                                                          |
| Build memory                       | Not comparably benchmarked. An OOM found while developing the new nf3 tracer was a new implementation defect, not evidence against Nitro. |
| Request throughput and latency     | Unknown. Both implementations use the same underlying request primitives.                                                                 |
| Cold start and emitted bundle size | Unknown. No controlled comparison has been run.                                                                                           |

## What is clearly better

### eve owns the final build graph

The pre-change host configured Nitro through `noExternals` mutation,
`rollup:before` and `build:before` hooks, custom module-side-effect plugins, and
a patch that found the Workflow plugin by the name `workflow:transform` and
wrapped its transform function. The old implementation is preserved in the
[merge-base source](https://github.com/vercel/eve/blob/98848101aba90a74ac26d7b238d675fe6b9b6483/packages/eve/src/internal/nitro/host/create-application-nitro.ts).

The new
[`application-bundler.ts`](../packages/eve/src/internal/host/application-bundler.ts)
defines the entry, plugin order, aliases, transforms, externals, tree shaking,
splitting, and output in one Rolldown call. The wrapper in
[`bundler/rolldown.ts`](../packages/eve/src/internal/bundler/rolldown.ts) imports
Rolldown directly instead of resolving Nitro's installed copy.

This is a maintainability win because the build's controlling inputs are
ordinary eve code. It is not a reduction in responsibility: eve now owns the
correctness that Nitro previously supplied.

### Workflow compilation has fewer repair stages

The old workflow builder emitted intermediate output, inserted step imports,
rewrote Workflow runtime imports and code literals, mirrored output into the
Nitro build tree, and relied on Nitro-specific exclusions to avoid transforming
the result again.

The new workflow builder generates the required entry source and encoded
workflow body directly. Production code under `internal/workflow-bundle` fell
from 3,844 to 3,280 lines, a reduction of 564 lines. The host still performs a
separate final Rolldown build, so this is not a single-pass compiler. The
improvement is fewer repair steps and a clearer boundary between workflow
artifacts and the host graph.

### Routing has one typed source of truth

[`application-route-registry.ts`](../packages/eve/src/internal/host/application-route-registry.ts)
computes package, authored channel, workflow, development, and cron routes.
[`application-router.ts`](../packages/eve/src/internal/host/application-router.ts)
mounts that registry in H3, and
[`vercel-output.ts`](../packages/eve/src/internal/host/vercel-output.ts) projects
the same data into Vercel output.

The old implementation translated eve routes into Nitro handler arrays and
generated virtual source modules, then normalized Nitro's Vercel output in a
separate phase. The direct registry makes precedence, deduplication, CORS, and
HTTP/WebSocket sharing testable without inspecting generated source strings or
mutating framework configuration.

### Lifecycle and WebSocket ownership are explicit

The Node host now returns a disposable handle and owns schedule admission,
transport closure, admitted fetches, transitive `waitUntil` work, and
application close hooks. Tests cover requests that register background work
during shutdown and development workers that close through env-runner.

The rewrite also fixed two concrete WebSocket behaviors:

- An upgrade to a successful ordinary HTTP route is rejected rather than
  accepted with empty hooks.
- An HTTP GET and WebSocket handler can share a path.

These are behavior improvements, although removing Nitro was not technically
required to implement them.

### Dependency versions and boundaries are explicit

eve now pins the primitives it invokes. This allowed the branch to move from
H3 rc.22 and srvx 0.11 to H3 rc.26 and srvx 0.12.5 without waiting for a Nitro
release. srvx 0.12 includes `waitUntil` retention and Node adapter fixes in its
[official release](https://github.com/h3js/srvx/releases/tag/v0.12.0).

Direct pins improve reproducibility, but they also transfer compatibility
testing to eve. The new relationship is better control, not free upgrades.

### Maintainability improved at the seams, not by deleting code

Across non-test TypeScript under `packages/eve/src`, production code changed
from 201,566 to 201,473 lines at the reviewed commits, a reduction of 93 lines.
The host namespace grew from 12,033 to 12,462 lines, while the workflow-bundle
namespace shrank by 564 lines. Test TypeScript grew by 671 lines.

Those counts reject two simplistic descriptions: the rewrite is neither a
large reduction in code nor a major code explosion. It trades private framework
coupling for eve-owned platform code. Change locality and observability are
better; the amount of code eve must maintain is roughly unchanged.

## What could have improved without removing Nitro

Not every improvement in PR #2056 was caused by removing Nitro. In several
cases, the migration created the incentive to address a problem that was
technically fixable in the old design.

The useful distinction is:

- **Independent:** achievable while retaining the existing Nitro host.
- **Existing extension point:** achievable with public Nitro configuration or
  hooks, while Nitro still owns the surrounding graph.
- **New upstream API:** possible cleanly only if Nitro exposes a different
  composable boundary.
- **Package architecture:** requires separately published packages; an API
  change inside the current package cannot produce the result.

| Improvement                                                                | Classification                  | Honest counterfactual                                                                                                                                                                                                                |
| -------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Smaller install and lock graph                                             | Package architecture            | Not achievable while depending on the current `nitro` package. Feature flags, lazy imports, and subpath exports do not remove package-manifest edges.                                                                                |
| Faster normal dependency resolution                                        | Package architecture            | Comes from removing the same package and optional-peer metadata. More runtime APIs would not change it.                                                                                                                              |
| Direct primitive versions                                                  | Mixed                           | eve could have declared H3 or Rolldown directly, but Nitro would still install and invoke its own ranges. That can duplicate versions and does not shrink the graph.                                                                 |
| Direct Rolldown for package, authored-module, and workflow helper builds   | Independent                     | eve already owned these builds and could have declared Rolldown directly while retaining Nitro for the final host build.                                                                                                             |
| Full ownership of the final Rolldown entry, plugins, externals, and output | New upstream API                | Nitro exposes `entry` and `rolldownConfig`, but it still creates the base graph, installs plugins, invokes Rolldown, scans handlers, and writes output. The old integration worked around that ownership through hooks and mutation. |
| Workflow source generation without text rewrites, mirrors, or inline maps  | Mostly independent              | Most workflow cleanup could have landed under Nitro. Nitro-specific transform exclusions, side-effect hooks, and `noExternals` handling would remain.                                                                                |
| A typed route registry                                                     | Existing extension point        | eve could have computed the registry and translated it into Nitro handlers. Eliminating virtual handler source and option mutation requires injected-app or route-manifest support.                                                  |
| Strict WebSocket upgrades and shared GET/WebSocket paths                   | Independent or upstream bug fix | These behaviors could have been fixed in eve's old adapters or in Nitro. They should not be credited intrinsically to dependency removal.                                                                                            |
| Explicit request and `waitUntil` draining                                  | Mixed                           | Close hooks existed, but complete control is awkward while the Node preset owns srvx, sockets, schedules, and signal handling without returning a host handle.                                                                       |
| Direct schedule runtime                                                    | Independent                     | Nitro v3 already uses Croner and coalesces concurrent calls by task name. eve could have strengthened tests and shutdown behavior without replacing the full host.                                                                   |
| Exact external tracing                                                     | New upstream API                | eve could run nf3 after Nitro, but that duplicates or conflicts with Nitro's externalization and tracing phase. A standalone classifier/tracer would make this clean.                                                                |
| Direct Vercel Build Output emission                                        | New upstream API                | eve could keep repairing Nitro output, as it already did. A single manifest-to-output pass requires a pure emitter or bypassing the preset.                                                                                          |
| Removing explicit public-assets and prerender calls                        | Independent                     | eve called these phases despite having no public assets or prerender routes. Those calls could have been removed independently if Nitro's builder allowed the remaining sequence.                                                    |
| Graceful development-worker shutdown                                       | Independent                     | The env-runner shutdown handshake and fallback termination do not inherently depend on the production host architecture.                                                                                                             |
| Workspace nested-build race removal                                        | Independent                     | Removing four nested `pnpm --filter eve build` invocations and guarding against their return is unrelated to Nitro.                                                                                                                  |
| Warning filtering and expanded route, lifecycle, package, and output tests | Independent                     | These are valuable results of the migration, but the old architecture could have had them.                                                                                                                                           |
| Drained development worker replacement                                     | Retained behavior               | The outer draining server already existed and was preserved. It is not a new benefit of the rewrite.                                                                                                                                 |

The install result is therefore the clearest improvement that fundamentally
required leaving the published Nitro package. Several architectural results
required leaving Nitro _as currently composed_ to implement them cleanly, but
could be recovered through new upstream component APIs. The remaining results
are engineering improvements that could have landed either way.

## What regressed or moved into eve

### Automatic native dependency classification is incomplete

The old path delegated native and non-bundleable classification to Nitro's nf3
database. The new bundler externalizes configured sandbox engines and authored
`build.externalDependencies`, then traces those explicit seeds. Tests prove
that configured native packages and their transitive closures are copied, but
they do not prove that an arbitrary nf3-known native package is classified
without configuration.

This can cause a previously automatic native dependency to reach Rolldown or
be omitted from output. Restore nf3-backed classification before bundling, or
make explicit external configuration an intentional public breaking change
with diagnostics and coverage. The former preserves the previous behavior and
is the recommended merge gate.

### Process signal exit semantics changed

The old sandbox shutdown path exited with conventional SIGINT and SIGTERM
codes, 130 and 143. The new Node host installs signal listeners and closes its
resources, but it neither re-raises the signal nor sets the corresponding exit
code after a successful close. Installing a listener suppresses Node's default
signal exit, so a normal shutdown can appear as exit zero.

Restore conventional process semantics and add a real subprocess signal test.

### Vercel route syntax is narrower

eve's public route helpers accept a path string, and H3 supports parameterized
and catch-all patterns. The new Vercel projection rejects trailing slashes,
wildcards, bracket forms, and mixed segments such as `foo-:id`. A route that
worked through Nitro can therefore fail during a Vercel build.

Either support the public route grammar in both H3 and Vercel output or narrow
and validate the authoring API consistently. Failing only for one deployment
target is the least desirable state.

### Undocumented Vercel and error behaviors changed

- The direct Vercel emitter always writes `nodejs24.x`; Nitro's Vercel preset
  could select Bun. Bun was not a documented eve production target, but the
  behavior existed.
- Development failures now use an eve JSON stack response rather than Nitro's
  Youch HTML response for HTML-accepting clients.
- Error envelopes, status text, and headers can differ from Nitro defaults.
- `NITRO_HOST` and `NITRO_PORT` aliases are no longer forwarded. `HOST` and
  `PORT` remain the documented eve controls.
- Workflow helper bundles no longer carry their previous inline source maps.
  This avoids very large generated files but can reduce stack-trace fidelity.

These do not all need compatibility code. They need explicit decisions so the
release notes and tests reflect intended behavior rather than accidental drift.

### eve now owns platform churn

The new Vercel emitter is approximately 600 lines and owns function layout,
route regular expressions, symlinks, cron configuration, queue metadata, and
runtime selection. eve also owns Node signal handling, CrossWS resolution,
schedule timers, and primitive-version compatibility.

Nitro's main strategic value is its provider support. Its documentation lists
Node, Cloudflare, Deno, Bun, AWS Lambda, Vercel, Netlify, and other deployment
targets through presets and compatibility dates. See Nitro's
[deployment documentation](https://nitro.build/deploy). eve currently
documents only Node self-hosting and Vercel, so this is primarily a future cost
rather than a removed documented feature. Adding another provider now requires
an eve adapter instead of selecting a Nitro preset.

### Important validation still missing

The branch has broad unit, integration, scenario, framework, packed-install,
HTTP, and real Node WebSocket coverage. It does not yet establish:

- comparative application build time, memory, runtime throughput, or cold
  start;
- automatic classification of an unconfigured nf3-known native package;
- real SIGTERM and SIGINT exit behavior;
- deployed Vercel WebSockets;
- a real production cron delivery and local Croner tick in emitted output;
- wildcard route parity, Vercel Bun output, or Windows development behavior;
- source-map diagnostic quality.

## What Nitro would need to change

Nitro v3 should receive credit for moving far beyond NitroPack v2. The Nitro
team reports reducing its dependency count from 321 to fewer than 20, adopting
H3 v2 and Rolldown, and compiling routes. See the
[`v3` announcement](https://nitro.build/blog/v3-beta). An isolated lock
snapshot in this review contained 387 package entries for `nitropack@2.13.4`,
37 for `nitro@3.0.260610-beta`, and 25 for eve's direct primitive graph.

The remaining problem is fit. The
[`nitro@3.0.260610-beta` manifest](https://github.com/nitrojs/nitro/blob/v3.0.260610-beta/package.json)
has 14 hard dependencies and 8 optional peer declarations. eve needs the
Rolldown, H3, CrossWS, srvx, nf3, and schedule layer, but not the default
storage, database, cache, proxy, or framework configuration surface.

### Fundamental package changes

The installation goal cannot be met by exposing additional functions from the
current package.

- A subpath such as `nitro/core` still installs every dependency in
  `nitro/package.json`.
- Dynamic imports and runtime feature flags can reduce code loaded at runtime,
  but package managers still resolve the manifest graph.
- `optionalDependencies` are installed by default unless the user explicitly
  omits them. See npm's
  [`optionalDependencies` documentation](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#optionaldependencies).
- Optional peers avoid automatic installation, but their names and ranges
  remain metadata that package managers evaluate against the rest of the
  tree. Moving everything to optional peers would reduce bytes more than it
  reduces resolution work.

The robust answer is separately published packages. Names are illustrative:

```text
nitro                         batteries-included CLI and framework
@nitropack/core               route/runtime contracts; no storage or database
@nitropack/rolldown           bundler integration; Rolldown supplied as a peer
@nitropack/trace              nf3 classification and tracing
@nitropack/node               disposable srvx/CrossWS Node host
@nitropack/vercel             pure Build Output API emitter and adapter
@nitropack/storage            opt-in unstorage integration
@nitropack/database           opt-in db0 integration
@nitropack/dev                opt-in development emulation
```

The existing `nitro` package can retain turnkey behavior by depending on those
components. Embedders would install only the pieces they use. Nitro has
previously discussed package modularization in
[#1362](https://github.com/nitrojs/nitro/issues/1362) and external preset
packaging in [#82](https://github.com/nitrojs/nitro/issues/82).

Removing unstorage from the minimal core is particularly important for
resolution: its
[`2.0.0-alpha.7` manifest](https://github.com/unjs/unstorage/blob/v2.0.0-alpha.7/package.json)
declares 23 optional peers for storage providers. db0's
[`0.3.4` manifest](https://github.com/unjs/db0/blob/v0.3.4/package.json) adds six
database-provider peers. These belong in feature packages, not in an
embedding kernel that does not use them.

Rolldown's platform bindings will remain when the build component is selected.
That cost is inherent to using Rolldown, not Nitro-specific.

### Public component APIs

Once the package graph is split, stable low-level APIs could let eve reuse the
parts Nitro is better positioned to maintain.

#### Caller-owned Rolldown

Nitro already exposes `entry`, `serverEntry`, `rolldownConfig`, `noExternals`,
`traceDeps`, and build hooks. The problem is not a complete absence of knobs.
The problem is that Nitro still constructs the base configuration, installs
its plugins, invokes Rolldown, scans the application, and writes the output.
See Nitro's current
[`NitroConfig` type](https://github.com/nitrojs/nitro/blob/16ff2809ae2bfc38e23835ea9c2f41fc8774d19a/src/types/config.ts)
and
[`rolldownConfig` construction](https://github.com/nitrojs/nitro/blob/16ff2809ae2bfc38e23835ea9c2f41fc8774d19a/src/build/rolldown/config.ts).

An embedding API should return entries and plugins for the caller's Rolldown
invocation. Rolldown should be a peer of the component package, and eve should
choose the exact version, plugin order, externals, warnings, and output.

#### Standalone classification and tracing

Expose native classification and tracing as operations over explicit bundle
results:

```ts
const trace = await traceExternals({
  externalSpecifiers,
  roots,
  conditions,
  includes,
});

await writeTrace(trace, outputDirectory);
```

Nitro main has improved its tracing since the published beta, including pnpm
and nested native-package fixes in
[#4391](https://github.com/nitrojs/nitro/pull/4391). Its current
[`externals` plugin](https://github.com/nitrojs/nitro/blob/16ff2809ae2bfc38e23835ea9c2f41fc8774d19a/src/build/plugins/externals.ts)
already traces observed external paths rather than treating the complete
self-contained server bundle as an undifferentiated seed. This narrows the
difference with eve. Publishing the classifier/tracer as a stable component
would be more useful than duplicating it.

#### Pure platform emitters

Expose Vercel and other presets as manifest-to-files operations:

```ts
await emitVercelBuildOutput({
  outputDirectory,
  functions,
  staticDirectory,
  routes,
  redirects,
  headers,
  crons,
});
```

The API should not require a mutable Nitro instance or a Nitro-owned build.
This would return provider-format maintenance to the Nitro team while keeping
eve's compiler and route registry authoritative.

#### A disposable Node host

Expose a Node host that accepts a Fetch application and returns `listen()` and
`close()` handles. Its shutdown contract should stop new schedule work, stop
HTTP and WebSocket admission, drain admitted requests and transitive
`waitUntil` tasks, close sockets, run asynchronous lifecycle hooks, and enforce
a deadline.

Nitro's current Node preset starts srvx and schedules at module evaluation and
does not expose that ownership boundary. See the
[`node-server` preset runtime](https://github.com/nitrojs/nitro/blob/16ff2809ae2bfc38e23835ea9c2f41fc8774d19a/src/presets/node/runtime/node-server.ts).

#### Explicit HTTP and WebSocket routes

The route manifest should represent HTTP and WebSocket handlers independently.
Nitro currently resolves WebSocket hooks by running the ordinary fetch path and
reading a private `crossws` property from the response. See the current
[`resolveWebsocketHooks`](https://github.com/nitrojs/nitro/blob/16ff2809ae2bfc38e23835ea9c2f41fc8774d19a/src/runtime/internal/app.ts).
That makes an ordinary successful HTTP response look like an upgrade candidate
and does not model an HTTP and WebSocket handler at one path cleanly.

### Version and correctness changes

Some improvements require neither a package redesign nor a new architectural
API:

- Update the Node adapter to srvx 0.12 or allow the host to supply it.
- Reject WebSocket upgrades unless a WebSocket route matched.
- Retain disposable schedule handles and define shutdown ordering.
- Publish a tested compatibility matrix for Rolldown, H3, CrossWS, srvx, and
  nf3.
- Release component fixes independently of the dated umbrella beta.

These changes would improve Nitro and reduce eve-owned work, but none alone
would fix the installation graph.

### What each class of Nitro change would accomplish

| Nitro change                                        | Change class          | Benefit to eve                                                | Sufficient by itself?                                                |
| --------------------------------------------------- | --------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------- |
| More feature flags or lazy imports                  | Configuration         | Less runtime/build work for unused features                   | No install-resolution improvement.                                   |
| Move hard dependencies to optional peers            | Manifest              | Fewer automatically installed packages                        | Partial; metadata and compatibility constraints remain.              |
| Publish physical core/build/trace/platform packages | Package architecture  | Recovers most dependency-count and resolution gains           | Necessary for the install goal.                                      |
| Add more `rolldownConfig` hooks                     | API                   | More customization around Nitro's build                       | No; Nitro still owns invocation and output.                          |
| Return Rolldown plugins for caller invocation       | API and package split | Lets eve own one final build graph                            | Yes for build ownership, not for install unless separately packaged. |
| Publish exact classifier/tracer operations          | API and package split | Restores automatic native handling without a full Nitro build | Yes for tracing responsibility.                                      |
| Publish pure Vercel/Node adapters                   | API and package split | Returns provider and lifecycle maintenance upstream           | Yes for those adapters.                                              |
| Upgrade srvx and fix strict WebSocket resolution    | Bug/version fix       | Correctness and leak fixes                                    | Valuable, but no package-graph effect.                               |

## Re-adoption criteria

eve should reconsider Nitro components when all of the following are true:

1. The selected packages do not install storage, database, cache, proxy,
   compatibility, generic dev-server, Vite, or Rollup packages.
2. On the same benchmark, normal npm lock resolution is within 10% of the
   direct graph, and the lock adds no more than a few thin wrapper packages.
3. eve invokes and pins Rolldown; the Nitro component does not install and
   invoke a second copy.
4. Native classification and exact external tracing are stable public APIs.
5. Node and Vercel adapters consume an already-built Fetch application and a
   route manifest.
6. The Node adapter exposes bounded disposal and covers requests, WebSockets,
   schedules, worker replacement, and transitive `waitUntil` work.
7. WebSocket upgrades reject non-WebSocket routes and allow HTTP plus
   WebSocket handling at one path.
8. The APIs are versioned public exports rather than source imports, mutable
   internal options, or plugin-name patches.

If Nitro reaches that shape, eve should prefer upstream tracing and platform
adapters over maintaining local copies. eve should retain its compiler,
workflow artifact generation, route registry, and final Rolldown invocation.
Re-adoption does not need to mean returning to the full `createNitro` build
lifecycle.

## Recommendation and merge gates

Keep the direct architecture. It delivers a measured package-manager
improvement and replaces private framework coupling with explicit eve-owned
boundaries. Do not describe it as a proven runtime-speed improvement or a broad
reduction in code.

Before merging PR #2056:

1. Restore automatic nf3 native/non-bundleable classification, or make the
   explicit-external requirement a deliberate public breaking change.
2. Restore conventional SIGINT and SIGTERM exit semantics with a subprocess
   test.
3. Decide and test the supported public route grammar across H3 and Vercel.
4. Decide whether Vercel Bun selection, development HTML errors, Nitro host
   environment aliases, and workflow source maps are intentionally removed.

After merge, collect comparable build time, build memory, emitted size, cold
start, and request-throughput measurements. Those results should determine
whether further bundling work is warranted; the install benchmark should not
be used as a proxy for runtime performance.
