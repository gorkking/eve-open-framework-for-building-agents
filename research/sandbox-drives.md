---
issue: https://github.com/vercel/eve/issues/508
status: proposed
last_updated: "2026-08-06"
---

# Vercel Drives: userspace drive lifecycle

eve should let agent authors execute sandbox creation over a drives-capable SDK. Authors own the
drive lifecycle: create, name, seed, mount, and delete. Drives provide sequential durability across
sandboxes over time; the platform's single-attachment constraint rules out concurrent sharing.

## Current state

### Platform behavior

Drives are persistent storage mounted when a sandbox is created. They are in private beta for Pro
and Enterprise teams, require enrollment, are free during the beta, and are explicitly not for
production data. See the [announcement](https://vercel.com/changelog/drives-for-vercel-sandbox-in-private-beta),
[documentation](https://vercel.com/docs/sandbox/concepts/drives), and
[guide](https://vercel.com/kb/guide/vercel-drives).

```ts
import { Drive, Sandbox } from "@vercel/sandbox";

const drive = await Drive.getOrCreate({
  name: "agent-workspace",
  maxSize: 200 * 1024 ** 3,
});
const sandbox = await Sandbox.create({
  mounts: { "/workspace": { drive: drive.name, mode: "read-write" } },
});
```

The constraints that shape the eve API are:

- Drives ship on `@vercel/sandbox@beta` (`2.10.0-beta.0` as of 2026-08-06).
- A drive can be mounted only during `Sandbox.create`; `Sandbox.update` cannot attach one.
- One drive can be attached to one sandbox at a time. A second mount fails rather than queues, and
  read-only mode does not avoid the constraint. Multi-reader support is planned; multi-writer
  support has not been announced.
- Stopping a sandbox detaches its drives without deleting their contents. This makes sequential
  reuse across sandboxes the supported sharing model.
- `Drive.list()` exposes `currentSandboxName`, so applications can observe attachment state.
- A sandbox can mount up to four drives. Each drive can hold up to 1 TiB and persists until deleted.

Whether a stopped sandbox automatically restores its persisted mounts when resumed remains
unverified. That behavior can change the eve lifecycle contract and is tracked under
[Open questions](#open-questions).

### Existing eve API

On `main`, eve owns every `Sandbox.create`; agent authors do not see the SDK. The author passes a
static `defaultBackend({ vercel: {...} })` or `vercel(options)` object. The Vercel backend forwards
that object on a fresh create, and the binding spreads it into `Sandbox.create`. Resume uses
`Sandbox.get` instead. eve vendors `@vercel/sandbox@2.8.0`, which has neither `Drive` nor `mounts`.

The `bootstrap` and `onSession` hooks map to `Sandbox.update`, so they cannot attach a drive after
creation.

Two in-flight changes are relevant:

- [Issue #508](https://github.com/vercel/eve/issues/508) and the closed research
  [PR #509](https://github.com/vercel/eve/pull/509) propose a framework-owned drive per session at a
  fixed mount path. That design avoids collisions by narrowing each drive to one session. It uses
  the same SDK and mount plumbing, but assigns naming and lifecycle policy to eve.
- [PR #1408](https://github.com/vercel/eve/pull/1408) proposes durable sandbox authoring, and its
  implementation [PR #1455](https://github.com/vercel/eve/pull/1455) adds
  `defineSandbox(async ({ session }) => ...)`. Authors execute provider creation with session
  context; templates are separate from live session sandboxes.

### Target workload

The primary target is a repository workspace. Dependency caches, generated artifacts, and seeded
data are secondary workloads. Repository workspaces are read-write and frequently overlap across
sessions, which is the worst case for a single-attached drive.

A coding agent cannot mount one repository drive into concurrent child sandboxes. That requires
multiple writers, beyond even the planned multi-reader support. A drive can be the durable backing
store for sequential work, or each child can clone and later synchronize through Git, but it cannot
be a shared live mount.

## Proposal

### Design constraints

The platform constraints are:

- **P1:** One attachment at a time; a concurrent mount fails without queueing.
- **P2:** Mounts are specified only at sandbox creation.
- **P3:** Drives currently require the beta SDK and private-beta enrollment.

The addressable eve constraints are:

- **S1:** Static options provide no create-time author code. One configured drive name applies to
  every fresh sandbox, including template prewarming.
- **S2:** The vendored SDK and public Vercel session options do not expose Drives.
- **S3:** Post-create hooks use `Sandbox.update`, which cannot mount a drive because of P2.

### Ownership

Drive lifecycle belongs to userspace. eve supplies the mechanism: author-executed creation and a
typed `mounts` passthrough. Applications choose the naming scope, seed data, delete drives, and
handle attachment conflicts.

Drive CRUD is already possible from host-side code through the beta SDK. Mounting is the part that
requires an eve creation surface.

### API changes

The implementation has three dependencies, in order:

1. Land the author-executed creation API in [PR #1455](https://github.com/vercel/eve/pull/1455):

   ```ts
   export default defineSandbox(async ({ session }) => {
     return template.getOrCreate({ name: `session-${session.id}` });
   });
   ```

2. Vendor the Drives SDK and add `mounts` to Vercel live-session creation. This is implemented in
   [PR #1726](https://github.com/vercel/eve/pull/1726):

   ```ts
   mounts?: Record<string, {
     drive: string;
     mode?: "read-write" | "read-only";
   }>;
   ```

   `VercelSandboxSessionOptions` accepts `mounts`, so it works with `VercelSandbox.create`,
   `template.create`, and `template.getOrCreate`. `VercelSandboxTemplateOptions` omits `mounts`, so
   build prewarming never attaches a userspace drive. The existing binding already forwards session
   options into `Sandbox.create`, so it needs no production change.

   eve also re-exports `Drive` from `eve/sandbox/vercel`. Applications then use the same vendored SDK
   and credential path for drive CRUD and sandbox creation instead of installing a potentially
   version-skewed copy.

3. Document Drives as sequential durability, not shared live state. Examples should default to a
   narrow scope such as one drive per repository or session. Concurrent children need separate
   workspaces and an explicit synchronization mechanism.

### Authoring flow

The application computes a drive name from session context. The name determines the sharing scope:

```ts
export default defineSandbox(async ({ session }) => {
  const repoId = session.auth.current?.attributes.repoId;
  if (typeof repoId !== "string") throw new Error("repo identity required");

  const drive = await Drive.getOrCreate({ name: `repo-${repoId}` });
  return template.create({
    mounts: { "/workspace": { drive: drive.name, mode: "read-write" } },
  });
});
```

Possible scopes include:

```ts
const repoDrive = `repo-${repoId}`;
const sessionDrive = `session-${session.id}`;
const userDrive = `user-${session.auth.current?.principalId}`;
const globalDrive = "shared-model-cache";
```

A scope is a claim about attachment concurrency, so it must be chosen against the platform's IO
limitation (P1). Today a drive supports exactly one attachment: one writer, and no additional
readers, because read-only mounts consume the same single slot. Under that constraint:

| Scope             | Concurrent attachment demand          | Fit under P1                                                           |
| ----------------- | ------------------------------------- | ---------------------------------------------------------------------- |
| `session-${id}`   | One sandbox per drive by construction | Safe; no collisions                                                    |
| `user-${id}`      | One user's overlapping sessions       | Collides when the same user runs sessions concurrently                 |
| `repo-${id}`      | Every session touching the repository | Collides under normal overlap; sequential handoff only                 |
| `shared-…` global | All sessions of the application       | Collides constantly; unusable as a live mount until multi-reader ships |

Planned multi-reader support relaxes only the read side: a read-mostly scope such as a shared
model or dependency cache becomes viable as `mode: "read-only"` for many sandboxes with one
writer. It does not change the write side — a repository workspace scope still admits exactly one
live writer, so multi-writer workloads must keep using clone-and-synchronize regardless.

A wider scope increases reuse and attachment collisions. A narrower scope increases isolation. eve
does not arbitrate this application-level decision, but examples should name the concurrency claim
each scope makes so authors choose deliberately.

The expected lifecycle is:

```text
session start    defineSandbox runs in userspace
                 -> Drive.getOrCreate returns the named drive
                 -> template.create({ mounts }) attaches it
work             tools use the mounted path
idle stop        sandbox stops; the drive detaches and retains its contents
next message     eve restores the sandbox with Sandbox.get
session expiry   a later definition run gets and reattaches the same drive
```

A fresh-create attachment conflict rejects `template.create` inside author code. The application can
retry, create an unmounted sandbox, or choose a narrower drive scope. No framework policy can make a
single drive writable by concurrent sessions.

If the durable sandbox API does not land, a static `vercel({ mounts: {...} })` option or #508's
`sessionDrive` is possible as an interim API. Both are narrower: static naming collides across
overlapping sessions, while `sessionDrive` fixes lifecycle policy inside the framework.

## Open questions

### Stop and resume

eve resumes an idle-stopped sandbox through `Sandbox.get`; `defineSandbox` does not run again. The
platform must define what happens to the persisted drive mount:

1. If resume automatically reattaches the drive, no eve API change is needed.
2. If resume succeeds without the mount, the mounted path can silently lose its expected contents.
   eve must fail resume or add author code to the resume path.
3. If another sandbox attached the drive while the first was stopped, reattachment can fail on a
   path where author code currently cannot choose a fallback.

The empirical check is: mount a drive, stop its sandbox, mount the drive from a second sandbox, then
resume the first and record the resulting attachment and error behavior.

### Conflict errors

The exact platform error for a second attachment is unverified. eve should preserve a typed or
otherwise detectable error so application retry and fallback code does not depend on string
matching.

## Research log

- 2026-08-03: Traced the application-to-eve-to-SDK creation path and confirmed no Drives support at
  any layer on the stable API.
- 2026-08-03: Separated userspace CRUD, which the SDK already permits, from creation-time mounting,
  which requires an eve surface.
- 2026-08-03: Confirmed creation-only mounting, detach-on-stop, failure on concurrent mount, beta
  distribution, and private-beta enrollment from platform documentation and SDK declarations.
- 2026-08-03: Compared #508/#509 with the durable sandbox API and identified author-executed creation
  as the general mechanism for userspace lifecycle ownership.
- 2026-08-06: Reframed the target as sequential durability after applying the single-attachment
  constraint to overlapping repository and child-agent workloads.
- 2026-08-06: Validated the SDK bump, public mount types, `Drive` export, live-session forwarding,
  template exclusion, and packaged declaration portability in #1726.
