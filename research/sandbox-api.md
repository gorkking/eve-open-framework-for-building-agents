---
issue: https://github.com/vercel/eve/issues/1406
status: proposed
last_updated: "2026-07-30"
---

# Sandbox API: durable values and build-prewarmed templates

## First principles

The runtime abstraction is a durable `Sandbox`. An app definition chooses or
creates one and returns it:

```ts
export default defineSandbox(async (ctx) => {
  return sandbox;
});
```

It does not return a backend, provider, factory, or binding. eve does not call
it later with an id to reconstruct the sandbox.

```ts
type SandboxDefinition = (ctx: SandboxDefinitionContext) => Sandbox | Promise<Sandbox>;

type SandboxDefinitionContext = {
  session: SessionContext["session"];
  runtime: { mode: "development" | "production" };
  signal: AbortSignal;
  parent: { sandbox: Promise<Sandbox> } | null;
  root: { sandbox: Promise<Sandbox> } | null;
};
```

There is no sandbox id, definition key, template key, or revalidation key in
this context.

An optional `SandboxTemplate` is a different value with a different lifetime.
It describes a provider-specific base that can be prepared during build. It is
not the sandbox definition and is not returned as the agent's sandbox.

| Value               | Purpose                                | Evaluated                     |
| ------------------- | -------------------------------------- | ----------------------------- |
| `SandboxTemplate`   | Prepare a reusable provider base       | Build                         |
| `SandboxDefinition` | Choose or create the session's sandbox | First session access          |
| `Sandbox`           | Provide files and processes            | Every use, restored as needed |

## Creation and restoration

eve invokes the definition only when the owning session has no compatible
sandbox value:

```text
first access
  → run authored definition
  → author returns Sandbox
  → eve persists Sandbox

later step, run, process, or deployment
  → deserialize persisted Sandbox
  → use it directly
  → authored definition does not run
```

A relevant change to the authored definition invalidates the stored value and
causes the definition to run again. The compatibility revision is private eve
bookkeeping.

The sandbox implementation owns durable serialization and restoration. Its
serialized form can contain Vercel SDK metadata, a Devbox id, a remote
workspace reference, or a local directory. Restoration produces a lazy handle;
the first operation may reconnect to the provider.

```ts
interface Sandbox extends SandboxSession {
  // Durability is supplied by the implementation, not app code.
}
```

## Build-prewarmed templates

A build cannot safely invoke the sandbox definition. The definition may inspect
the session, choose among providers, return a parent sandbox, or create a real
resource. Build-time preparation therefore needs a separate, statically
discoverable value.

The app exports a provider-owned template from its sandbox module:

```ts
// agent/sandbox/sandbox.ts
import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";

export const template = VercelSandbox.template({
  async prepare(sandbox) {
    await sandbox.run({
      command: "pnpm install --frozen-lockfile",
    });
  },
});

export default defineSandbox(() => {
  return template.create({
    resources: { vcpus: 4 },
  });
});
```

`VercelSandbox.template()` is synchronous and has no provider side effects. It
returns a branded `VercelSandboxTemplate`. Its `create()` and `getOrCreate()`
methods return actual durable sandboxes.

The export is the build/runtime bridge:

```text
compile
  → discover branded template exports
  → associate each template with its agent and managed workspace

build
  → ask the implementation to prepare a provider resource
  → install eve's base runtime and managed workspace
  → run prepare()
  → capture an opaque provider reference
  → write that reference into the deployment artifacts

runtime
  → bind the same template export to the built reference
  → invoke the authored sandbox definition
  → template.create(...) returns a live Sandbox from that reference
  → persist the returned Sandbox
```

The runtime loader binds the reference before invoking the definition. Because
the definition closes over the same module-scoped template object, its
`create()` call sees the result produced by that build.

The export name is not a provider name or cache key. eve derives private
identity from the compiled module and export. The deployment contains the exact
opaque reference produced by prewarming, such as a Vercel snapshot id, so
runtime does not recompute it from a different environment.

The private template revision includes:

- compiled preparation code;
- provider-declared preparation options;
- discovered build assets;
- managed workspace contents; and
- eve's sandbox runtime contract.

The implementation can use this revision to reuse provider state. If it cannot
prove an external input is unchanged, it rebuilds instead of asking the app
author for a revalidation key.

A required prewarm failure fails the build. Runtime may use the same
preparation path to repair provider state that disappeared after the build, but
ordinary production startup does not depend on lazy preparation.

Template preparation is session-independent. Session-dependent options belong
on `create()` or on the returned sandbox. If runtime can choose among multiple
templates, each possibility is exported and prewarmed:

```ts
export const standard = VercelSandbox.template();
export const python = VercelSandbox.template({
  async prepare(sandbox) {
    await sandbox.run({ command: "uv sync --frozen" });
  },
});

export default defineSandbox(({ session }) => {
  const template = session.auth.current?.attributes.runtime === "python" ? python : standard;

  return template.create({
    resources: { vcpus: 4 },
  });
});
```

An app that does not need a reusable base creates a sandbox directly:

```ts
export default defineSandbox(() => VercelSandbox.create());
```

## Vercel authoring cases

### Current behavior

An authored workspace uses an empty exported template:

```text
agent/sandbox/
├── sandbox.ts
└── workspace/
```

```ts
// agent/sandbox/sandbox.ts
import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";

export const template = VercelSandbox.template();

export default defineSandbox(() => {
  return template.create({
    resources: { vcpus: 2 },
  });
});
```

The build compiles `workspace/` into the template, prepares a Vercel snapshot,
and freezes the snapshot reference into the deployment. The first session
creates persistent Vercel compute from that snapshot. Later runs restore that
same sandbox rather than creating from the template again.

### Configure the actual sandbox

The author can configure the live sandbox before returning it:

```ts
// agent/sandbox.ts
import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";

export const template = VercelSandbox.template({
  async prepare(sandbox) {
    await sandbox.run({
      command: "pnpm install --frozen-lockfile",
    });
  },
});

export default defineSandbox(async ({ session }) => {
  const sandbox = await template.create({
    resources: { vcpus: 4 },
  });

  await sandbox.setNetworkPolicy(
    session.auth.current === null ? "deny-all" : { allow: ["api.github.com"] },
  );

  await sandbox.writeTextFile({
    path: ".eve/owner.txt",
    content: `${session.auth.current?.principalId ?? "anonymous"}\n`,
  });

  return sandbox;
});
```

`prepare()` runs during build. The network policy and owner file run once when
the owning session creates its durable sandbox. Restoration reruns neither.

### Reuse across runs and sessions

Reuse across runs of one eve session is automatic:

```text
eve session s_1, first run  → create sandbox → persist Sandbox value
eve session s_1, later run  → deserialize the same Sandbox value
```

To intentionally share one real Vercel sandbox across independent eve
sessions, the application chooses the same provider resource:

```ts
// agent/sandbox.ts
import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";

export const template = VercelSandbox.template();

export default defineSandbox(async ({ session }) => {
  const teamId = session.auth.current?.attributes.teamId;
  if (typeof teamId !== "string") {
    throw new Error("A team identity is required");
  }

  return template.getOrCreate({
    name: `team-${teamId}-workspace`,
  });
});
```

Each eve session persists its own serialized handle, but both handles address
the same Vercel sandbox. The prewarmed template is used only when the named
sandbox does not exist.

Sharing live compute means both sessions see the same files and processes,
commands can race, and per-user credentials or network policy cannot safely
differ. The provider or application owns retention and deletion.

## Docker authoring cases

### Direct Docker sandbox

An app can return a Docker sandbox without using a template:

```ts
// agent/sandbox.ts
import { defineSandbox } from "eve/sandbox";
import { DockerSandbox } from "eve/sandbox/docker";

export default defineSandbox(() => {
  return DockerSandbox.create({
    image: "ghcr.io/vercel/eve:latest",
  });
});
```

`DockerSandbox.create()` starts a live container and returns it as the durable
`Sandbox`. The wrapper serializes the container reference, so later runs
reattach to the same container rather than invoking the definition again.

### Docker sandbox built from a Dockerfile

An adjacent Dockerfile is a build input to an exported Docker template:

```text
agent/sandbox/
├── Dockerfile
├── sandbox.ts
└── workspace/
```

```dockerfile
# agent/sandbox/Dockerfile
FROM ghcr.io/vercel/eve:latest
RUN sudo apt-get update \
  && sudo apt-get install -y --no-install-recommends imagemagick
```

```ts
// agent/sandbox/sandbox.ts
import { defineSandbox } from "eve/sandbox";
import { DockerSandbox } from "eve/sandbox/docker";

export const template = DockerSandbox.template();

export default defineSandbox(() => {
  return template.create();
});
```

During prewarm, the Docker implementation builds the image, starts a temporary
container from it, hydrates the managed workspace, and commits the result as a
local template. `template.create()` starts the session container from that
template and returns the actual durable sandbox.

## Parent and child sharing

A child that should use the parent's sandbox returns the parent's durable
value:

```ts
// agent/subagents/reviewer/sandbox.ts
import { defineSandbox } from "eve/sandbox";

export default defineSandbox(({ parent }) => {
  if (parent === null) {
    throw new Error("reviewer must be called as a child");
  }

  return parent.sandbox;
});
```

A nested child can return `root.sandbox` in the same way. The durable boundary
carries the serialized sandbox value plus an internal owner marker:

```ts
type BorrowedSandbox = {
  ownerNodeId: string;
  ownerSessionId: string;
  value: Serialized<Sandbox>;
};
```

The child never constructs or interprets this record. The owner marker ensures
that retiring the child does not delete or replace the parent's sandbox.

## Local filesystem and custom implementations

The definition can return a different implementation by runtime mode:

```ts
import { LocalFilesystemSandbox, defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";

export default defineSandbox(({ runtime }) => {
  if (runtime.mode === "development") {
    return LocalFilesystemSandbox.open({
      root: ".eve/workspaces/development",
    });
  }

  return VercelSandbox.create();
});
```

A provider package can adapt any raw handle into a durable sandbox:

```ts
const asDevboxSandbox = defineSandboxAdapter<Devbox, { id: string }>({
  reference(devbox) {
    return { id: devbox.id };
  },
  restore({ id }) {
    return Devbox.get({ id });
  },
  session(devbox) {
    return adaptDevboxSession(devbox);
  },
});

export default defineSandbox(async ({ session }) => {
  const devbox = await Devbox.create({
    owner: session.auth.current?.principalId,
  });

  return asDevboxSandbox(devbox);
});
```

`asDevboxSandbox(raw)` is the durable value. The adapter, not the app
definition, owns serialization and lazy restoration.

A prewarm-capable implementation can additionally expose a branded template
through `defineSandboxTemplate()`. Internally it implements two phases:

- `prewarm({ assets, hydrate })` consumes compiled preparation assets, creates
  a temporary provider sandbox, lets eve hydrate the managed workspace, and
  returns a serializable provider reference; and
- `bind(reference)` installs the build result so the template's public creation
  methods can return live sandboxes from it.

Neither method nor the reference appears in app definitions.

## Dockerfile build contract

The compiler associates the Dockerfile build context with the exported
template. The Docker example above builds it locally. A
`VercelSandbox.template()` paired with the same filesystem input can perform:

```text
Dockerfile
  → build and push a provider-compatible OCI image
  → start a temporary Vercel sandbox from that image
  → hydrate the managed workspace
  → run prepare()
  → capture a Vercel snapshot
  → freeze the snapshot reference into the deployment
```

In both cases runtime needs neither the Dockerfile nor an image builder. It
consumes the provider reference produced by prewarming.

The Dockerfile path, context digest, registry image, snapshot id, and cache
identity remain private. An explicit provider `image` and a discovered
Dockerfile are mutually exclusive because both define the template's base.

When an authored `sandbox.ts` is present, a Dockerfile requires an exported
template. A future Dockerfile-only shorthand can synthesize the same default
template and definition; it is filesystem sugar over this protocol, not
another lifecycle.

## Alternatives considered

| Shape                               | Why not                                                 |
| ----------------------------------- | ------------------------------------------------------- |
| Build-time definition execution     | A fake session cannot represent dynamic branches safely |
| Compiler analysis of provider calls | Breaks on dynamic code and custom implementations       |
| Templates passed to `defineSandbox` | Duplicates the value and pollutes the core API          |
| Module-scope side-effect discovery  | Makes hidden registration order part of correctness     |

The exported branded template is the smallest explicit static boundary. The
sandbox definition remains a plain function returning a sandbox.

## Observable invariants

- A sandbox definition returns a `Sandbox`.
- Build prewarms exported provider templates without invoking the sandbox
  definition.
- The template reference is opaque to app code and frozen into deployment
  artifacts.
- Definitions run for creation or replacement, never routine restoration.
- Sandbox implementations own serialization and restoration.
- App definitions never receive framework identity or template keys.
- Independent sessions share only when they return handles to the same
  provider resource.
- Parent and root sharing carries the durable sandbox value, not a live
  process-local object.

## Resulting app API

```ts
defineSandbox((ctx) => Sandbox | Promise<Sandbox>)
VercelSandbox.create(options): Promise<Sandbox>
VercelSandbox.template(options): VercelSandboxTemplate
VercelSandboxTemplate.create(options): Promise<Sandbox>
VercelSandboxTemplate.getOrCreate(options): Promise<Sandbox>
DockerSandbox.create(options): Promise<Sandbox>
DockerSandbox.template(options): DockerSandboxTemplate
DockerSandboxTemplate.create(options): Promise<Sandbox>
LocalFilesystemSandbox.open(options): Sandbox | Promise<Sandbox>
ctx.parent.sandbox: Promise<Sandbox>
ctx.root.sandbox: Promise<Sandbox>
```

The app returns a sandbox. Sandbox implementations own provider preparation
and durable restoration. eve owns build discovery, reference binding,
persistence, compatibility, and ownership.
