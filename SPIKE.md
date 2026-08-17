# Subagents as Workflow tools spike

**Conclusion: this prototype is on eve's production delegation path: when the
root agent enables `experimental.tasks`, every local or remote subagent call is
started as a distinct Workflow-backed `defineTool` execution before re-entering
the existing task and subagent dispatch machinery.**

## Runtime path

1. `turnStep` reads `resolvedAgent.config.experimental.tasks`. The turn
   workflow selects `dispatchTaskStep` only when that value is `true`; plain
   mode continues to select `dispatchRuntimeActionsStep`.
2. `dispatchTaskStep` leaves rejections and task-control calls in the parent
   step. For each local or remote delegation it calls
   `dispatchSubagentWorkflowTool` with the model-authored input and a private,
   serializable invocation context.
3. The dispatcher starts the branded `subagentWorkflowTool.execute` function by
   its compiler-assigned `workflowId`. One model call therefore maps to one
   addressable Workflow run.
4. The tool workflow invokes `dispatchSubagentWorkflowToolStep`. That step
   rehydrates the current parent session, verifies that the pending action and
   serialized tool input still match the original plan entry, and executes
   that entry without reclassifying a continuation as a fresh start.
5. The existing entry path creates the task run before the child start, starts
   the real local eve runtime or remote transport, persists the child address,
   and returns the normal working-task receipt. The task run remains the sole
   writer for progress, input, completion, failure, and cancellation.

The Workflow tool run ends after dispatch admission. It does not wait for the
background task to finish, so it neither duplicates the task lifecycle nor
holds a second task inbox.

## Verified behavior

- The focused Workflow integration test starts the compiled `defineTool`
  executor, a durable task run, and a real local eve child session. It asserts
  that all three run IDs are distinct and that the parent receives the normal
  task receipt and addressed child handle.
- The existing dispatch integration suite executes the production tool step
  against both local and remote targets. It keeps only the executor/network
  boundaries mocked and covers admission, start failures, continuation
  availability, mid-batch handle removal, and remote delivery semantics.
- The workflow-step unit test proves that the resolved
  `config.experimental.tasks` value reaches the durable park result only when
  enabled. The turn-workflow unit test then proves that this value selects
  `dispatchTaskStep`; the existing plain-mode case continues to select
  `dispatchRuntimeActionsStep`.

## Scope boundary

This is an internal architecture prototype, not a new public authoring API.
The harness still records subagent calls as `runtimeAction` requests, because
that is how model tool calls park and resume today. The prototype changes the
task-mode execution substrate behind that request: the production dispatcher
now starts an ordinary branded `defineTool` Workflow for each delegation.

Task-control tools are intentionally not Workflow-backed subagent tools: they
operate on the parent session's task index and do not invoke an agent. Plain
mode is unchanged. A public lowering that removes `runtimeAction` entirely
would be a separate API change with a larger harness contract and is not
required to validate this execution model.
