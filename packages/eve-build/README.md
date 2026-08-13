# @eve/build

Project-local build engine for [`eve`](https://eve.dev) applications. It supplies Nitro and
Rolldown to `eve dev` and `eve build` without adding that dependency graph to lightweight
`npx eve` commands.

Install this package as a development dependency alongside the matching `eve` version:

```sh
pnpm add eve
pnpm add --save-dev @eve/build
```

This package is an internal implementation boundary. Applications should invoke `eve` commands
instead of importing `@eve/build`.
