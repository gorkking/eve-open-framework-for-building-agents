# Subagents as Workflow tools spike

**Conclusion: this prototype is on eve's production delegation path: when the
root agent enables `experimental.tasks`, each local or remote subagent call is
started through its own Workflow-backed `defineTool` definition before both
transports converge on the durable task lifecycle.**

## Runtime path

1. `turnStep` reads `resolvedAgent.config.experimental.tasks`. The turn
   workflow selects `dispatchTaskStep` only when that value is `true`; plain
   mode continues to select `dispatchRuntimeActionsStep`.
2. `dispatchTaskStep` leaves rejections and task-control calls in the parent
   step. It classifies each delegation once and calls either
   `subagent/local.ts` or `subagent/remote.ts` with the model-authored input and
   a private, serializable invocation context.
3. Each module owns a separate `defineTool` value and Workflow executor with a
   distinct compiler-assigned `workflowId`. Each dispatch attempt therefore
   starts an addressable, transport-specific Workflow run.
4. Each tool workflow invokes the shared admission step only after transport
   selection. That step
   rehydrates the current parent session, verifies that the pending action and
   serialized tool input still match the original plan entry, asserts that the
   entry matches the selected transport, and executes it without reclassifying
   a continuation as a fresh start.
5. The subagent admission step creates the task run before the child start,
   starts the real local eve runtime or remote transport, persists the child
   address, and returns the normal working-task receipt. The task run remains
   the sole writer for progress, input, completion, failure, and cancellation.

The Workflow tool run ends after dispatch admission. It does not wait for the
background task to finish, so it neither duplicates the task lifecycle nor
holds a second task inbox.

## HITL boundary

The durable task run is the shared owner of `working -> input_required ->
working`. The child transport is not shared:

- A local child sends `input.requested` to the task inbox with `resumeHook` and
  receives the answer on its child continuation hook.
- A remote child posts `task.input-requested` to the task callback URL and
  receives the answer through its `/eve/v1/task-input/:token` HTTP capability.

The parent namespaces and records either request only after validating the
task-owned child address. A human answer returns to the task run first; the task
run forwards it to the local hook or remote response URL and leaves
`input_required` only after that delivery succeeds. The production turn step
now invokes the remote task-event publisher; previously that publisher and the
remote callback/answer routes existed but the publisher had no production
caller.

## Verified behavior

- The focused Workflow integration test proves the local and remote definitions
  have distinct Workflow IDs, then starts the local executor, a durable task
  run, and a real local eve child session. It asserts that all three run IDs are
  distinct and that the parent receives the normal task receipt and addressed
  child handle.
- The existing dispatch integration suite executes the production tool step
  against both local and remote targets. It keeps only the executor/network
  boundaries mocked and covers admission, start failures, continuation
  availability, mid-batch handle removal, and remote delivery semantics.
- Focused callback tests prove a remote `input.requested` event is posted by the
  child turn, accepted by the parent callback route, and can carry approval
  candidate and settlement events over the same transport.
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

The wrapper Workflow start is an external side effect inside the retryable task
dispatch step. Task and child admission remain replay-safe because their
identities are deterministic, but this spike does not deduplicate or retain the
wrapper run ID: a retry after `start()` succeeds can leave an extra completed
wrapper run. A production contract that requires exactly one observable tool
run per call needs a persisted idempotency boundary the current Workflow
`start()` API does not expose.
