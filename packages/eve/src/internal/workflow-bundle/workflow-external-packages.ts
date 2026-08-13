// just-bash and microsandbox are optional peer dependencies (the
// opt-in local sandbox engines) loaded lazily from the application's
// install; just-bash additionally exposes native optional codecs for
// xz/zstd support. All of these must stay external so workflow step
// bundles neither fail resolving an absent optional install nor try to
// inline platform-specific `.node` artifacts.
export const WORKFLOW_STEP_EXTERNAL_PACKAGES = [
  "@mongodb-js/zstd",
  "just-bash",
  "microsandbox",
  "node-liblzma",
] as const;
