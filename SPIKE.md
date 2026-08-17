# Subagents as workflow tools spike

**Conclusion: this isolated spike is a working end-to-end prototype: a
test-only dispatcher starts a `defineTool` workflow plus a selected local or
remote-style executor workflow, carries progress and human input in both
directions, and resolves the tool with the executor's canonical output.**

The prototype lives in
`packages/eve/src/internal/testing/subagents-as-workflow-tools-spike/`. Its
`internal/testing` location lets eve's existing Workflow test builder compile
the functions without adding them to a production entrypoint.

## Executed lifecycle

1. `defineSubagent` and `defineRemoteSubagent` return branded `defineTool`
   values whose `execute` functions carry compiler-assigned `workflowId`s.
2. The test-only dispatcher reads private target metadata from the tool,
   creates two prototype hook tokens, and starts the tool workflow by
   `workflowId`.
3. Once the tool workflow owns its inbox, the dispatcher selects and starts a
   distinct local or remote-style executor workflow.
4. The executor posts progress, requests human input, blocks on its private
   inbox, receives the forwarded response, and produces output.
5. The tool workflow records the bidirectional transcript and returns the
   executor's output as its canonical result.

The integration test drives this lifecycle for both target kinds. It supplies
only the human response; progress, the input request, response forwarding, and
output are produced or routed by the running workflows. It also asserts that
the tool and executor have distinct Workflow run IDs.

## Deliberate isolation

This is a completely decoupled prototype. It does not call eve's production
harness, task runtime, subagent adapter, local agent runner, or remote transport.
Its hook envelopes borrow the observable event names `task_post_message`,
`input.required`, and `input.response`, but the surrounding protocol and tokens
belong only to this spike.

That boundary means the prototype proves the proposed composition can execute;
it does not prove production compatibility, scheduling, cancellation, usage
attribution, authorization forwarding, recursion policy, or persistent
continuations.

## Context boundary

Workflow arguments are serialized by value. Today's live `ToolContext` contains
capability functions and runtime handles, so the prototype dispatcher supplies
a plain invocation descriptor containing call, tool, and parent-session
identity. Target identity and hook tokens are framework-selected context, not
model-authored tool input.
