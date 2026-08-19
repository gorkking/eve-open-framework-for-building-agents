# Subagents as `defineTool` calls

**Conclusion: with `experimental.tasks`, static local and remote subagents are
`defineTool` tools executed by the AI SDK loop.**

`defineSubagent` and `defineRemoteSubagent` live in
`runtime/framework-tools/subagent/local.ts` and `remote.ts`. The node installs
them only in task mode; plain mode keeps the existing RuntimeAction definitions.
Dynamic subagents and task-control tools are unchanged, and the implicit
`agent` tool remains root-only.

Each AI SDK tool execution starts `executeSubagentWorkflow`, which calls
the existing `dispatchTaskStep` with that call. Sibling calls start concurrently.
The turn-local executor combines their task and agent registrations in the parent
session before child readiness is released. It cancels and acknowledges started
tasks if the model step fails. No pending RuntimeAction batch is created for these
calls.

Local children publish HITL events to their task inbox. Remote children use the
existing authenticated task callback URL. Existing task APIs continue to own
progress, input, approval, completion, failure, and cancellation.

The production-path integration runs AI SDK `generateText` -> `defineTool` ->
Workflow -> `dispatchTaskStep` -> durable task -> local child and checks the
receipt, handle, events, and terminal output. Focused tests cover the task-mode
gate, local and remote execution, failure cleanup, and readiness ordering.

This is an internal prototype and adds no public authoring API.
