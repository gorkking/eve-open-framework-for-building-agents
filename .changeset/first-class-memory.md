---
"eve": patch
---

Add path-authored memory slots with configurable namespaces, required trusted scopes, scope-aware projections, configurable cross-scope visibility, and async turn-scoped provider tools backed by dynamic tool replay. Scope resolvers receive trusted session and channel context, may return colon-joined string components, and can use the `byPrincipal` helper from `eve/memory/scope`.
