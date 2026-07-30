import type * as Vercel from "#compiled/@vercel/sandbox/index.js";

type VercelCreateOptions = NonNullable<Parameters<typeof Vercel.Sandbox.create>[0]>;

type VercelUpdateOptions = Parameters<Vercel.Sandbox["update"]>[0];

type VercelSandboxInternalCreateOptions = {
  readonly [key: `__${string}`]: unknown;
};

type VercelSandboxAuthorCreateOptions<T> = T extends unknown
  ? Omit<T, "name" | "onResume" | "persistent" | "runtime" | "signal"> &
      VercelSandboxInternalCreateOptions
  : never;

/**
 * Options accepted by `VercelSandbox.create()`, a Vercel template, or
 * `template.create()`. Durable restoration does not create a new provider
 * resource, so options are not re-applied.
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
 * `source` is honored only on the template create at prewarm time, so
 * an author-supplied snapshot, git revision, or tarball becomes the
 * base layer for the template. Framework setup, preparation, and managed
 * files all run on top, and the resulting
 * framework-owned snapshot is what every later session derives from,
 * so `source` is stripped from the session-create path.
 */
export type VercelSandboxCreateOptions = VercelSandboxAuthorCreateOptions<VercelCreateOptions>;

/**
 * Internal template update options retained by the built-in bridge.
 */
export type VercelSandboxBootstrapUseOptions = VercelUpdateOptions;

/**
 * Internal live-session update options retained by the built-in bridge.
 */
export type VercelSandboxSessionUseOptions = VercelUpdateOptions;
