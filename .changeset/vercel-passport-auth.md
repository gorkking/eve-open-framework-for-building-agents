---
"eve": patch
---

Add `vercelPassport()` to `eve/channels/auth`, a route-auth helper for agents behind Vercel Passport. It verifies the Passport-injected `x-vercel-oidc-passport-token` header (or a forwarded bearer token) — signature, issuer, `typ`, and a fail-closed project/environment bind — and authenticates the visitor as a `user` principal. The low-level verifier is exported as `verifyVercelPassport(token, opts)`.
