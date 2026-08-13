---
issue: https://github.com/vercel/eve/issues/1224
status: proposed
last_updated: "2026-08-13"
---

# One HITL engine

## Decision

Implement every HITL transition through one durable state ledger and one pure
interpreter:

```ts
function interpretHitl(
  state: HitlState,
  input: HitlInput,
): HitlDecision;
```

The lifecycle contract in
[`hitl-request-lifecycle.md`](./hitl-request-lifecycle.md) remains the
behavioral source of truth. This document defines the implementation boundary
that makes that contract enforceable in one place.

The driver admits inputs. The interpreter decides. The store persists. The
executor performs one ordered effect list. No other module may change an
obligation, classify a response, or decide whether input starts a model turn.

## Why consolidate

The current mechanism has no authoritative decision seam. HITL behavior is
split among:

- approval/question resolution and deferral;
- stale-response conversion;
- required/dismissable classification;
- session-limit prompt creation and resolution;
- authorization challenge storage, callback extraction, and callback waits;
- projected child-request routing;
- cancellation and session-end sweeps.

The principal touch surface is 6,780 lines across 14 modules, with 39 source
files consuming at least one of the fragmented state APIs. Not all of those
lines are rewritten: `tool-loop.ts` alone is 3,073 lines and should become an
executor adapter, not move into the HITL package. The problem is
coupling, not total code volume.

Both known wedges came from that dispersion:

1. Approval input was admitted but reclassified into `deferredStepInput`, so
   no model turn ran.
2. Authorization changed the driver's wait source, so ordinary input was not
   admitted at all.

In both cases an obligation became control flow. In the target, obligations
are only data and the scheduler is always receptive.

### Current

Obligation state and interpretation are split across the driver, turn setup,
tool loop, proxy, and closure paths:

```text
channel message / response
           │
           ▼
 SessionCommandInbox ───────────────▶ workflow-entry driver
                                               │
                                               │ dispatch turn
                                               ▼
                                       workflow-steps
                                  authorization callback pairing
                                               │
                                               ▼
                                          tool-loop
                                               │
                ┌──────────────────────────────┼───────────────────────────┐
                ▼                              ▼                           ▼
      stale-input-responses          resolvePendingInput          session-limit logic
      stale → user message           approval/question rules      prompt special cases
                │                              │                           │
                └──────────────────────────────┼───────────────────────────┘
                                               │
                                     model / tool execution
                                               │
                       ┌───────────────────────┼──────────────────────┐
                       ▼                       ▼                      ▼
             pendingInputBatches      pendingAuthorization    deferredStepInput
                       │                       │
                       │                       │ authorizationNames
                       │                       ▼
                       │              workflow-entry changes
                       │                 its wait source
                       │                       │
                       │                       ▼
                       │                dedicated :auth hook
                       │
                       └────── next delivery re-enters several decision paths

OAuth redirect
     │
     ▼
callback route ──▶ dedicated :auth hook ──▶ authorization-only driver wait

child HITL event ──▶ subagent proxy logic ──▶ separate proxy route store

cancel / session end ──▶ settlement sweep ──▶ mutates request state separately
```

No function sees the complete state and input: the driver interprets
authorization state by changing its wait source; workflow steps pair
callbacks; stale conversion, pending-input resolution, and limit enforcement
each interpret deliveries; proxy and closure paths write related state
independently.

### Target

All inputs enter one ordered stream. One interpreter decides every transition;
one store persists it before one executor performs the ordered effects:

```text
channel message / response ─┐
OAuth callback ──────────────┤
timer / deadline ────────────┼──▶ SessionCommandInbox
control / cancellation ──────┤          one FIFO stream
child HITL event ─────┘                │
                                              ▼
                                      workflow-entry driver
                                      admit + dispatch only
                                      no obligation state
                                              │
                                              ▼
                                       turn input adapter
                                   normalize HitlInput
                                              │
                                              ▼
                                    executeHitl
                                              │
                                              ▼
                                  load HitlState
                                              │
                                              ▼
                                  interpretHitl
                            pure: (state, input) → decision
                                              │
                           ┌──────────────────┴──────────────────┐
                           ▼                                     ▼
                       nextState                        ordered effects
                           │                                     │
                           ▼                                     ▼
                 persistHitlState             emit lifecycle event
                    the only writer                   restore group output
                                                     execute allowed tool
                                                     run model turn
                                                     forward child response
                                                     terminate turn
                                                             │
                                                             ▼
                                                         TurnOutcome
                                                             │
                                                             └──▶ interpret again
```

The architectural invariant is: **the driver schedules, the interpreter
decides, the store persists, and the executor performs.** No other module may
settle, dismiss, supersede, reject, buffer, or resume an obligation.

## Target package

```text
packages/eve/src/harness/hitl/
  types.ts         state, inputs, transitions, ordered effects
  obligations.ts   durable ledger + migration; the only state writer
  interpret.ts     pure state/input -> decision function
  projector.ts     child route transitions
  events.ts        domain transition -> protocol event
  execute.ts       persist decision, then execute ordered effects
```

These files are one package and one ownership boundary, not independent
subsystems. Splitting by concern keeps each source file below the repository's
line cap without distributing policy again.

## API

### Input

```ts
type HitlInput =
  | { type: "delivery"; delivery: AdmittedDelivery }
  | { type: "timer"; timer: AuthorizationDeadline | SessionDeadline }
  | { type: "turn-outcome"; outcome: TurnOutcome }
  | { type: "child-event"; event: ChildHitlEvent }
  | { type: "control"; control: CancelTurn | EndSession };
```

`AdmittedDelivery` has a server-assigned `deliveryId`, verified actor or null,
and exactly the wire content received: message, structured responses,
authorization callback, client context, or their permitted compound form.
Adapters normalize transport shapes before interpretation; the interpreter
never reads HTTP requests, hook identities, or continuation tokens.

### State

```ts
interface HitlState {
  version: 1;

  obligations: Record<ObligationId, Obligation>;
  groups: Record<GroupId, ObligationGroup>;
  groupOrder: readonly GroupId[];

  candidates: Record<CandidateId, ResponseCandidate>;
  routes: Record<RequestId, ProjectionRoute>;

  nextLimitGeneration: number;
}
```

Obligations stay in the ledger after reaching a terminal state until the
session ends. That terminal record is what classifies duplicate responses and
late callbacks as stale; there is no second stale-response mechanism.

```ts
type ObligationStatus =
  | { state: "open" }
  | { state: "settled"; outcome: SettlementOutcome }
  | { state: "dismissed"; reason: DismissalReason }
  | { state: "completed"; outcome: AuthorizationOutcome };

interface ObligationGroup {
  id: GroupId;
  memberIds: readonly ObligationId[];
  ownerTurn: TurnCoordinates;
  continuation: ApprovalBatchContinuation | AuthorizationContinuation | LimitContinuation;
  continuationState: "pending" | "claimed" | "suppressed";
}
```

`claimed` is the atomic single-winner boundary for continuation execution.
The durable workflow journal makes execution after that claim replay-safe.
Forced closure moves it to `suppressed`.

### Decision

```ts
interface HitlDecision {
  nextState: HitlState;
  effects: readonly HitlEffect[];
}

type HitlEffect =
  | { type: "emit"; event: InputLifecycleEvent }
  | { type: "restore-group"; groupId: GroupId }
  | { type: "execute-tool"; callId: string }
  | { type: "run-model"; input: ModelTurnInput }
  | { type: "forward-response"; routeId: string; response: InputResponse }
  | { type: "terminate-turn" };
```

Effects are one ordered list. Separate event and execution arrays would be
incorrect because the contract orders them against each other — for example,
`input.responded` before restored output and tool execution, then
`message.received` for a compound delivery.

`interpretHitl` is pure: no context container, persistence, network,
model, tool, stream, clock, or hook access. Timers and verified identity arrive
as input values.

### Execution

```ts
async function executeHitl(
  session: HarnessSession,
  input: HitlInput,
): Promise<HitlExecutionResult> {
  const decision = interpretHitl(loadHitlState(session), input);
  session = persistHitlState(session, decision.nextState);

  for (const effect of decision.effects) {
    const outcome = await executeHitlEffect(session, effect);
    if (outcome !== undefined) {
      return executeHitl(session, { type: "turn-outcome", outcome });
    }
  }

  return { session };
}
```

Persistence precedes side effects. An effect that produces a model/tool/child
outcome feeds that outcome back through the same interpreter; executors never
mutate HITL state themselves.

## Adapter changes

### Tool loop

The tool loop remains responsible for AI SDK transcript conversion, tool
execution, and model calls. It stops interpreting HITL:

- step input becomes `HitlInput.delivery`;
- parked model output becomes an ApprovalBatch continuation;
- new requests/challenges become `turn-outcome` inputs;
- `resolvePendingInput`, stale conversion, and limit special cases disappear;
- approval isolation and compound response/message sequencing are explicit
  effects, not `deferredStepInput` decisions.

### Workflow driver

`workflow-entry.ts` becomes a scheduler only:

- callbacks use the same command stream as messages and responses;
- delete the authorization hook window and source tagging;
- dispatch each admitted input to the turn adapter in arrival order;
- session timeout is a `HitlInput.timer`.

### Workflow steps

`workflow-steps.ts` normalizes inputs and executes effects. It no longer pairs
callbacks with `pendingAuthorization`, emits authorization lifecycle events,
or derives several pending-state booleans from unrelated keys.

### Session limit

The budget gate emits a `turn-outcome` that opens `Limit(generation)`. Continue,
Stop, supersession, and stale generations are ordinary interpreter rows.

### Projection

Child-request hooks become `child-event` inputs. The projector transitions in
the same state ledger add, forward, close, or drop routes. Existing proxy
modules retain only transport adaptation until they can be deleted.

## Deletions

After migration and adapter cutover:

- `harness/stale-input-responses.ts`;
- `harness/input-request-class.ts`;
- pending-batch and pending-authorization state writers outside the HITL
  package;
- driver authorization-window APIs and callback counting;
- runtime calls to `resolveTextToResponses` (the export remains for channel
  adapters);
- proxy-request state and settlement logic outside `projector.ts`;
- `deferredStepInput` as policy. If internal-step plan persistence remains
  necessary, it stores a serialized effect cursor owned by the HITL
  executor, not reinterpretable user input.

## Migration

`loadHitlState` reads the new key first, then migrates these legacy
sources in memory:

- pending input batch collection and the older singleton batch;
- `pendingAuthorization` challenges;
- session-limit continuation requests;
- projected child-request routes;
- `deferredStepInput`.

The first HITL write stores only `HitlState`. Legacy deferred
messages become ordered pending effects, so upgrading releases already-wedged
input without matching it against newly created obligations.

In-flight authorization callback URLs are the only transport compatibility
problem: they embed the old `${sessionId}:auth` hook. Either claim that alias
for one release and forward into the command stream, or accept a pre-1.0 break
for open challenges. The compatibility choice does not change the target
interpreter.

## Invariants

Machine-check these at the store/interpreter boundary:

1. Only `persistHitlState` writes obligation state.
2. Every obligation belongs to exactly one group.
3. Terminal obligations never transition again.
4. A group continuation moves from `pending` exactly once, to either
   `claimed` or `suppressed`.
5. Every candidate identifies one obligation and admitted delivery.
6. Every route identifies one child-owned obligation or terminal tombstone.
7. Every admitted input produces an observable effect or a documented no-op
   transition; nothing is silently buffered.
8. Interpreter output is deterministic for equal state and input.

## Test strategy

- **Interpreter unit matrix:** one literal case per transition anchor; inputs,
  pre-state, next-state, and ordered effects are authored expectations, never
  computed by production helpers.
- **Store tests:** migration, round-trip serialization, terminal tombstones,
  group closure, and invariants.
- **Adapter integration:** AI SDK transcript restoration, effect execution
  order, callback normalization, driver FIFO admission, and child forwarding.
- **E2e:** the anchor-keyed suite in the lifecycle contract verifies the wire
  events and real session behavior. Evals never import the interpreter.

## Stack

Each PR leaves the repository deployable and has one falsifiable invariant.

1. **Store foundation.** Add types, ledger, read migration, and invariants.
   Existing behavior unchanged.
2. **Interpreter extraction.** Move approval/question resolution, stale
   handling, and limit decisions into the pure function without changing
   outcomes.
3. **Auth integration.** Model challenges as groups; callbacks and deadlines
   pass through the interpreter; multi-challenge continuation closes on the
   last member.
4. **Single stream and projection.** Remove the auth wait path; callbacks use
   the session command stream; move routes into the projector state machine.
5. **Target semantics.** Per-member settlement, actor guards, candidate races,
   text-match removal, generations, forced closure, and fail-closed creation.
6. **Lifecycle events.** Emit protocol events from ordered effects and activate
   the gated e2e catalog.

After PR 4, every remaining behavioral change is a diff to `interpret.ts` and
its unit matrix.

## Size

This is a **large internal architecture change**, but not a rewrite of eve's
execution engine.

Measured current surface:

- 6,780 lines in the 14 principal modules involved;
- 39 source/test files consume fragmented HITL state APIs;
- 3,073 of those lines are `tool-loop.ts`, which remains and receives adapter
  edits rather than wholesale replacement.

Expected total across the six-PR stack:

| Area                                    | Expected churn                    |
| --------------------------------------- | --------------------------------- |
| production TypeScript                   | 2,500–4,000 changed lines         |
| unit/integration tests                  | 2,000–3,000 changed lines         |
| e2e fixtures/evals and protocol schemas | 800–1,500 changed lines           |
| total                                   | roughly 5,000–8,000 changed lines |

Expected net production growth is approximately −300 to +500 lines: the new
store/interpreter/executor package is offset by deleting stale conversion,
classification, auth-window, duplicate state writers, and proxy policy.

Risk is concentrated in transcript restoration and durable migration, not in
the pure transition logic. The stack order retires those risks separately:
store migration first, behavior-preserving interpreter second, side-effecting
adapters after both are covered.
