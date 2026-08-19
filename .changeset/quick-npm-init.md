---
"eve": patch
---

Speed up fresh standalone npm scaffolds by skipping npm's resolution of unused optional peer dependencies. Existing projects and ancestor workspaces retain normal peer dependency resolution.
