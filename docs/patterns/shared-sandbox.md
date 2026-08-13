---
title: "Share a sandbox with a subagent"
description: "Let a declared subagent work in its parent's filesystem and process environment."
---

A declared subagent normally gets its own sandbox. Share the parent's exact durable sandbox when both agents need to work on the same checkout, files, or running processes:

1. the parent creates its sandbox normally;
2. the child's sandbox definition returns `parent.sandbox`;
3. eve reattaches the child's session to the parent's provider sandbox.

The complete runnable source lives in [`examples/shared-sandbox`](https://github.com/vercel/eve/tree/HEAD/examples/shared-sandbox).

The parent owns creation. This example pins it to Vercel Sandbox:

```ts title="examples/shared-sandbox/agent/sandbox.ts"
import { defineSandbox } from "eve/sandbox";
import { vercel } from "eve/sandbox/vercel";

export default defineSandbox({
  backend: () => vercel(),
});
```

The declared child returns the parent's durable value instead of creating another sandbox:

```ts title="examples/shared-sandbox/agent/subagents/worker/sandbox.ts"
import { defineSandbox } from "eve/sandbox";

export default defineSandbox(({ parent }) => {
  if (parent === null) {
    throw new Error("worker must run as a child");
  }
  return parent.sandbox;
});
```

The callback form is for selecting a parent sandbox. The child must run through a parent that already initialized its sandbox; if `parent` is `null`, fail explicitly as above.

Both sessions now resolve file operations against the same `/workspace`. Conversation history and `defineState` remain independent.

Sharing does not serialize writes. Give parallel children separate files, directories, branches, or worktrees. Do not share a sandbox when children need different credentials, network policies, or execution isolation.

The example's [`shared-filesystem` eval](https://github.com/vercel/eve/blob/HEAD/examples/shared-sandbox/evals/shared-filesystem.eval.ts) proves both directions: the worker reads a parent-created nonce file, then the parent reads a worker-created proof file.
