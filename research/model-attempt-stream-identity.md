---
issue: https://github.com/vercel/eve/issues/1454
status: proposed
last_updated: "2026-08-07"
---

# Identify logical model steps and physical attempts separately

A durable step can restart after it has already written partial model output. The restarted call reuses `turnId` and `stepIndex`, but its cumulative text and reasoning begin from zero. Consumers cannot distinguish that replacement from corrupt or out-of-order output. The same index can also be reused by a legitimate HITL or runtime-action continuation, so replacing every repeated index would discard valid output.

## Protocol

Stream version 22 adds two opaque identities:

- `stepId` identifies one logical harness step across durable retries.
- `attemptId` identifies one physical model execution within that step.

`step.started` carries `stepId`. Each model execution emits `attempt.started` with both IDs, and attempt-owned output, actions, results, and terminal events carry the same pair. A new attempt under the same step supersedes the older attempt in conversation projections. A new step remains a continuation even when it reuses `stepIndex`.

```text
turn
└── step stp_A
    ├── attempt atp_A  (superseded)
    └── attempt atp_B  (projected)
└── step stp_B         (preserved continuation)
```

Raw events remain an audit trail. Supersession neither deletes events nor rolls back tool side effects.

## Identity and durability

The Workflow adapter derives an eve-owned `stepId` from `getStepMetadata().stepId` without exposing Workflow's value or type. Direct harness execution mints an eve step ID. Every model call mints a fresh attempt ID and reuses it for instrumentation.

Pending input, authorization, and runtime-action state journals the originating IDs so resume events stay attached to the attempt that parked. Readers accept missing IDs on pre-v22 durable events and retain the accumulator-reset heuristic only for that legacy prefix.

## Projection

The default reducer and dev TUI project stamped events by `{turnId, stepId, attemptId}`. Starting a replacement attempt removes the older attempt's text, reasoning, and tool presentation. Different step IDs remain separate regardless of index reuse. Durable `meta.id` continues to deduplicate delivery of each raw event independently of attempt supersession.
