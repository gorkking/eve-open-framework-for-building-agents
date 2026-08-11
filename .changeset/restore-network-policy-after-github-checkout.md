---
"eve": patch
---

GitHub checkout now scopes its broker network policy to the fetch window and restores the session's prior policy afterwards, so the installation-token header transform and the broker's open `"*"` egress no longer outlive the checkout. `SandboxSession` gains `getNetworkPolicy()` for reading the policy the session is currently running under.
