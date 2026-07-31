import type * as Vercel from "#compiled/@vercel/sandbox/index.js";

type VercelCreateOptions = NonNullable<Parameters<typeof Vercel.Sandbox.create>[0]>;

type VercelSandboxAuthorCreateOptions<T> = T extends unknown
  ? Omit<T, "fetch" | "name" | "onResume" | "persistent" | "runtime" | "signal" | "token">
  : never;

/**
 * Options accepted by `VercelSandbox.create()`, a Vercel template, or
 * `template.create()`. Durable restoration does not create a new provider
 * resource, so creation-only options are not re-applied.
 *
 * `networkPolicy` is deferred until after framework-owned base setup
 * for fresh templates and template-less sessions, so eve can install
 * required packages before authored template preparation runs. Template-backed
 * session creates receive it at creation time because the template
 * already contains the prepared base runtime.
 *
 * Framework-injected fields (`name`, `onResume`, `persistent`, `signal`)
 * are excluded: the framework owns those and overrides any
 * author-supplied values.
 *
 * `runtime` is excluded as well: eve always boots its sandboxes from the
 * published eve image, which is mutually exclusive with a stock runtime.
 *
 * `token` and `fetch` are excluded because they cannot be serialized into a
 * durable sandbox reference. Runtime authentication is resolved from Vercel
 * OIDC or environment credentials whenever eve reconnects.
 *
 * `source` is honored by direct creation and by template prewarming. For a
 * template, an author-supplied snapshot, git revision, or tarball becomes the
 * base layer. Framework setup, preparation, and managed files all run on top,
 * and later template-backed sessions derive from eve's resulting snapshot
 * instead of reapplying the original source.
 */
export type VercelSandboxCreateOptions = VercelSandboxAuthorCreateOptions<VercelCreateOptions>;
