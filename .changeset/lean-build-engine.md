---
"@eve/build": patch
"eve": patch
---

Move Nitro and Rolldown into the project-local `@eve/build` development package so lightweight
`npx eve` commands no longer resolve Nitro's dependency graph. New and updated projects install
the matching engine automatically; existing projects must add `@eve/build` before running source
compilation commands.
