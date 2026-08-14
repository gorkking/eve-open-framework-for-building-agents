# Subagents as workflow tools spike

**Conclusion: workflow functions can implement ordinary `defineTool` values,
and the subagent helpers can lower onto that primitive without making workflow
runs synonymous with tasks. Workflow dispatch must pass serializable invocation
data instead of today's live `ToolContext`.**

This repository is an isolated clone of Eve commit
`37314a9f29c96c802461ab69e40e9b2801c2219a` on branch
`spike/subagent-workflow-tools`. Nothing in the source checkout used to create
it is modified.

## What the executable spike proves

The prototype lives in
`packages/eve/src/internal/testing/subagents-as-workflow-tools-spike/` and uses
the real Eve `defineTool` and Workflow build/test pipeline. Its location under
`internal/testing` makes Eve's existing Workflow test builder discover the
prototype without adding it to a production entrypoint.

1. An ordinary, non-agent `defineTool` accepts a named `"use workflow"`
   function as `execute`; the existing compiler assigns it a `workflowId`, and
   Workflow starts it as an addressable run.
2. `defineSubagent` and `defineRemoteSubagent` return genuine `defineTool`
   definitions. Neither helper exposes `runAgent`.
3. Each helper supplies a named `"use workflow"` function as `execute`; the
   existing compiler gives that function a `workflowId`, and Workflow can start
   it as an addressable run.
4. A generic workflow tool accepts a serializable invocation descriptor with
   call, tool, and parent-session identity. Subagent-only task identity and
   inbox routing extend that descriptor rather than becoming generic fields.
   Private target identity is symbol metadata on the definition, not
   model-authored input.
5. One existing subagent task inbox can carry advisory `task_post_message`
   envelopes, HITL request/response envelopes, and canonical output without
   collapsing them: advisory and HITL events use separate parent/child streams,
   while canonical output is the workflow return value.

## Deliberate scope boundary

This spike does not introduce the universal tool-task scheduler discussed in
the companion research. In that separate design every tool execution is a
`Task`; a runtime timeout or human command may dynamically demote an already
running task to `BackgroundTask`; and every background task has a matching
Workflow run while retaining distinct task and run identities.

Supporting workflow functions in `defineTool.execute` is a prerequisite for
that scheduler, not its implementation. This spike does not add `Task`,
`BackgroundTask`, timeout demotion, task-to-run indexing, receipts, or join
semantics.

## What it does not prove

- The production harness does not yet classify a workflow-backed `execute` and
  start its `workflowId`; it still invokes every authored tool inside the
  harness step.
- The spike drives the task inbox directly. It does not yet replace that test
  driver with `startLocalSubagent` / `startRemoteSubagent` and the existing
  `SUBAGENT_ADAPTER`.
- Existing subagent task indexing, cancellation, usage attribution,
  authorization forwarding, recursion policy, and persistent `agentId`
  continuations remain on the current specialized dispatch path.

## Constraint discovered by the spike

Workflow arguments are serialized by value. Today's `ToolContext` includes an
`AbortSignal` plus credential, sandbox, and skill capability methods, so it
cannot be the second argument passed to `start(execute, args)`. The runtime
needs two context constructs:

- plain tools keep today's live `ToolContext`;
- workflow tools are started with serializable invocation data, and
  framework-owned step functions reconstruct live capabilities when needed.

For framework-owned subagent workflows this is tractable because authors never
program against that internal context. A generic authored workflow-tool API
still needs an explicit public context design; this spike does not hide that
decision behind a cast.

## Next production slice

The smallest production patch is to detect `execute.workflowId` while building
the harness tool definition, park that call as one generic workflow-tool
runtime action, and start the workflow outside the harness step. The local and
remote helpers can then move onto that substrate while retaining the existing
task run and subagent adapter as the owners of parent messages and HITL.
