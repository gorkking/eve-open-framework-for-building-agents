# Subagents as `defineTool` calls

**Conclusion: with `experimental.tasks`, static local and remote subagents are
`defineTool` tools executed by the AI SDK loop.**

`defineSubagent` and `defineRemoteSubagent` live in
`runtime/framework-tools/subagent/local.ts` and `remote.ts`. The node installs
them only in task mode; plain mode keeps the existing RuntimeAction definitions.
Dynamic subagents and task-control tools are unchanged, and the implicit
`agent` tool remains root-only.

Each AI SDK tool execution starts `executeSubagentWorkflow`, which calls
the existing `dispatchTaskStep` with that call. Calls for different agents start
concurrently after one `actions.requested` event for the sibling set.
Continuations targeting the same persistent agent are admitted in
order so `dispatchTaskStep` can enforce its one-active-task invariant against the
updated parent session; if an earlier sibling removes that address, the later
call fails as unreachable rather than becoming a fresh start. Fresh local
siblings share the parent token remainder by the full AI SDK fanout. The
turn-local executor combines task and agent registrations before child readiness
is released, and cancels and silently rejects started tasks if the model step fails.
No pending RuntimeAction batch is created for these calls.

Local children publish HITL events to their task inbox. Remote children use the
existing task callback URL. Existing task APIs continue to own
progress, input, approval, completion, failure, and cancellation.

The production-path integration runs AI SDK `generateText` -> `defineTool` ->
Workflow -> `dispatchTaskStep` -> durable task -> local child and checks the
receipt, handle, events, and terminal output. Focused tests cover the task-mode
gate, local and remote execution, failure cleanup, and readiness ordering.

This is an internal prototype and adds no public authoring API.

As with the existing child-start path, a durable parent-step retry after
`start()` succeeds but before the step commits can create an extra wrapper
Workflow run. Dispatch identity derives from the replay-stable parent turn,
model-step index, canonical action fingerprint, and occurrence among identical
actions rather than the provider's retry-variant tool-call id or sibling order.
The same semantic call therefore converges on the same task and child, while
reordered siblings cannot adopt each other's ownership. Eliminating the extra
wrapper run itself requires a Workflow `start()` idempotency key, which the
current runtime does not expose.
