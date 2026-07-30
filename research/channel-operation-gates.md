---
issue: https://github.com/vercel/eve/issues/1021
status: proposed
last_updated: "2026-07-30"
---

# Channel operation gates

A channel should answer one policy question before it changes an existing
session: may this authenticated actor perform this operation now? Authentication
establishes who the actor is. A gate uses that identity, the operation, and the
authoritative session to allow or deny the mutation.

Add gates to `defineChannel` for resuming a session, answering pending human
input, and invoking a proactive channel receive. Gates run before the protected
operation. They are distinct from channel events, which observe lifecycle
activity after it occurs.

## Goals

- Authorize follow-up delivery with the actor identity supplied by the channel.
- Authorize every form of pending-input resolution before eve consumes it.
- Cover full input requests proxied from descendant sessions.
- Authorize proactive channel and schedule handoffs before `receive()` runs.
- Evaluate session policy against authoritative durable state.
- Leave session, channel, input, and continuation state unchanged on denial.
- Fail closed without exposing gate exceptions through public transports.
- Keep first-party channel APIs and initial session creation unchanged.

## Authoring API

The core app-facing shape is:

```ts
defineChannel({
  gates: {
    "session.resume": (input, channel, ctx) => ChannelGateDecision,
    "input.response": (input, channel, ctx) => ChannelGateDecision,
    "channel.receive": (input, ctx) => ChannelGateDecision,
  },

  // Existing state, context, routes, receive, and events.
});
```

Every configured gate returns an explicit tagged decision:

```ts
export type ChannelGateDecision = { type: "allow" } | { type: "deny"; reason?: string };
```

Boolean and implicit returns are invalid. An omitted gate allows its operation.
A configured gate that throws, returns an invalid value, or cannot run fails
closed as unavailable.

The common responder policy remains small:

```ts
export default defineChannel({
  gates: {
    "input.response": (_input, _channel, ctx) => {
      const current = ctx.session.auth.current?.principalId;
      const initiator = ctx.session.auth.initiator?.principalId;

      return current !== undefined && current === initiator
        ? { type: "allow" }
        : {
            type: "deny",
            reason: "Only the initiating user may respond.",
          };
    },
  },

  routes,
  state,
  context,
  events,
});
```

An application can use external policy without moving session state out of eve:

```ts
export default defineChannel({
  gates: {
    async "session.resume"(input, channel, ctx) {
      return (await permissions.mayResume({
        actor: ctx.session.auth.current,
        sessionId: ctx.session.id,
        threadId: channel.threadId,
        message: input.message,
      }))
        ? { type: "allow" }
        : { type: "deny" };
    },
  },

  routes,
  state,
  context,
});
```

## Core model

```ts
export interface ChannelGateContext {
  readonly session: {
    readonly id: string;
    readonly auth: {
      readonly current: SessionAuthContext | null;
      readonly initiator: SessionAuthContext | null;
    };
    readonly turn: SessionTurn;
    readonly parent?: SessionParent;
  };
}

export interface ChannelReceiveGateContext {
  readonly source:
    | { readonly type: "channel"; readonly name: string }
    | { readonly type: "schedule"; readonly name: string };
}

export type SessionResumeGateInput = SendPayload;
export type ChannelSessionGateName = "session.resume" | "input.response";
export type ChannelGateName = ChannelSessionGateName | "channel.receive";

type ChannelSessionGate<TInput, TContext> = (
  input: TInput,
  channel: Readonly<TContext>,
  ctx: ChannelGateContext,
) => ChannelGateDecision | Promise<ChannelGateDecision>;

export interface ChannelGates<TContext = void, TReceiveTarget = Record<string, unknown>> {
  readonly "session.resume"?: ChannelSessionGate<SessionResumeGateInput, TContext>;
  readonly "input.response"?: ChannelSessionGate<InputResponseGateInput, TContext>;
  readonly "channel.receive"?: (
    input: ReceiveInput<TReceiveTarget>,
    ctx: ChannelReceiveGateContext,
  ) => ChannelGateDecision | Promise<ChannelGateDecision>;
}
```

`ChannelDefinition` gains one optional property:

```ts
interface ChannelDefinition<TState, TContext, TReceiveTarget, TMetadata> {
  // Existing fields omitted.
  readonly gates?: ChannelGates<TContext, TReceiveTarget>;
}
```

The three gates protect values with different ownership:

| Gate              | Protected operation                    | Policy state                          |
| ----------------- | -------------------------------------- | ------------------------------------- |
| `session.resume`  | Admit a follow-up to an active session | Authoritative target session          |
| `input.response`  | Resolve or dismiss pending human input | Pending local and descendant requests |
| `channel.receive` | Invoke an authored proactive receive   | Receive input and trusted source name |

`auth.current` is the actor requesting the protected session operation.
`auth.initiator` is fixed when the session starts. Gate evaluation occurs
before eve replaces the session's current auth with the requesting actor.
The existing low-level `Agent.deliver()` shape remains unchanged; an omitted
`DeliverInput.auth` is normalized to `null` at this boundary.

## Session delivery

Initial session creation is not a resume and does not run a gate. A follow-up
to an existing session runs policy at the workflow that currently owns that
session:

```text
channel send
  → resolve continuation hook
  → target workflow receives attributed operation
  → normalize without mutation
  → session.resume
  → input.response when applicable
  → existing delivery path
```

`session.resume` receives the normalized `SendPayload` that would enter the
existing delivery path. `input.response` runs only when the same delivery would
answer or dismiss pending input. The session gate order is fixed:

1. `session.resume`;
2. `input.response`, when applicable;
3. adapter delivery and session mutation.

The first denial or unavailable result stops that operation. One denied
delivery does not deny another delivery that happened to arrive in the same
workflow batch.

### Attributed operations and receipts

The continuation hook currently establishes that a workflow accepted a
payload, not that target-owned policy allowed it. Session gates therefore need
one internal request and receipt boundary:

```ts
type DeliveryOperation = {
  id: string;
  auth: SessionAuthContext | null;
  payload: SendPayload;
  receipt: { namespace: string };
};

type DeliveryReceipt =
  | { type: "allowed" }
  | { type: "denied"; gate: ChannelSessionGateName; reason?: string }
  | { type: "unavailable"; gate: ChannelSessionGateName; errorId?: string };
```

The public runtime creates the operation id, resumes the existing hook, and
reads one receipt from the resolved workflow run. If an active turn owns
delivery, the operation and receipt identity follow the existing forwarding
path to that turn. The workflow that evaluates policy writes the receipt.

Delivery buffering preserves operation envelopes until policy has run. It does
not replace several actors with the latest `auth`. Allowed payloads may enter
the existing coalescing path after each actor has been evaluated independently.

A denied or unavailable receipt is written without changing durable state. An
allowed receipt is written once the operation is durably admitted to the
existing delivery path. It does not wait for the resulting agent turn to
finish.

Internal workflow messages do not use this public operation envelope. OAuth
callbacks, subagent results, session timeouts, runtime cancellation, and other
control-plane deliveries retain their existing behavior and do not invoke
channel gates.

## Pending input

Every route that can answer pending input must describe the same logical
resolution to policy. The gate input is:

```ts
export interface InputResponseGateInput {
  readonly requests: readonly InputRequest[];
  readonly resolution:
    | {
        readonly type: "responses";
        readonly source: "explicit";
        readonly responses: readonly InputResponse[];
      }
    | {
        readonly type: "responses";
        readonly source: "text";
        readonly text: string;
        readonly responses: readonly InputResponse[];
      }
    | {
        readonly type: "dismiss";
        readonly source: "message";
        readonly message: string;
      };
}
```

eve derives this value without changing the pending batch:

- explicit `inputResponses` select the active requests they address;
- a text reply uses the existing typed-option and freeform resolver and
  includes the responses it derived;
- an ordinary message produces `dismiss` only when the existing input rules
  would dismiss the local pending batch;
- a stale response that cannot affect pending input does not run
  `input.response`.

The `requests` array contains every active request relevant to the resolution,
not a reduced request id or kind. Descendant proxy state therefore retains the
full `InputRequest` alongside its routing metadata:

```text
child input.requested
  → parent stores full request + child continuation token
  → channel submits response
  → parent evaluates input.response with the full request
  → allowed response routes to the child
```

After allowance, the delivery uses the normalized responses already shown to
the gate. It does not independently reinterpret the same text and risk a
different result. An unauthorized attempt leaves the original input requests
pending so a later authorized actor can answer them.

## Gate context and mutation

Session gates receive the channel's authored context because policy may need a
thread, tenant, installation, or other channel-owned identifier. They do not
receive `ChannelSessionOps`, so a gate cannot call `setContinuationToken()`.

eve builds this context from a cloned adapter state and a non-committing
session facade. It supplies cloned session context with `auth.current` set to
the requesting actor. Nothing from that evaluation is serialized back:

```text
authoritative context + adapter state
  → clone
  → build authored channel context
  → evaluate gate
  → discard clone
  → allow: run the existing operation against authoritative state
  → deny: leave authoritative state unchanged
```

This isolates channel state, current auth, continuation identity, pending
input, turn identity, and session status. It cannot roll back an external API
call performed by authored policy. Gates should therefore be policy-oriented,
retry-safe, and idempotent.

## Durable declarations

A session records the names of its configured session gates when it starts:

```ts
type ChannelGateDeclaration = readonly ("session.resume" | "input.response")[];
```

The declaration is durable session context, not a new public manifest field.
Gate functions continue to rehydrate through the existing channel adapter
registry.

Before evaluating current policy, the target verifies that the gate name was
declared by that session. A session created before a newly configured gate
cannot silently bypass it or execute policy through an old workflow shape; the
operation fails unavailable and the session must be restarted. Removing an
authored gate restores the normal omitted-gate behavior for later operations.

## Proactive receive

`channel.receive` protects only calls to an authored `receive()` callback:

```text
source channel route ─┐
                      ├─ source identity → channel.receive → receive()
schedule trigger ─────┘
```

Cross-channel dispatch supplies `{ type: "channel", name }`. Schedule dispatch
supplies `{ type: "schedule", name }`. The names come from the resolved
filesystem channel and schedule definitions; the caller does not provide them.

The gate receives the same typed `ReceiveInput` that `receive()` would receive.
It runs immediately before that callback and therefore before the callback can
create a session or call `send()`. No workflow receipt is required because the
caller already awaits `receive()`.

Ordinary inbound webhook routes are not proactive receives and do not run this
gate. Route authentication and application-specific route protection remain
separate concerns.

## Errors and transport behavior

`eve/channels` exports a small error hierarchy:

```ts
class ChannelGateError extends Error {
  readonly gate: ChannelGateName;
}

class ChannelGateDeniedError extends ChannelGateError {
  readonly reason?: string;
}

class ChannelGateUnavailableError extends ChannelGateError {
  readonly errorId?: string;
}
```

An authored denial reason is treated as safe application copy. A thrown
exception or invalid decision is logged once with an opaque error id and
becomes `ChannelGateUnavailableError`. Its cause, message, and stack never
cross a public transport.

Awaited generic HTTP handlers map denial to `403` and unavailability to `503`.
A denial response may include the authored reason. An unavailable response
contains the stable error code and opaque error id only.

Direct `send()`, `Agent.deliver()`, and proactive receive callers observe the
typed error. Existing fallback from `send()` to initial session creation
continues only for the typed no-active-session result; a gate failure never
starts another session.

## Definition and factory boundary

Gate callbacks are behavior on the value returned by `defineChannel`. Compiled
and resolved channel values retain that behavior through the same adapter
registry used for context, delivery, events, file fetching, and metadata.
Presence of `gates` makes an otherwise behavior-light definition use that
registry rather than the stateless HTTP adapter path.

First-party channel factories do not add a `gates` option in this proposal.
Slack, Discord, Teams, Telegram, Linear, GitHub, Twilio, and Chat SDK keep their
current configuration and behavior. Applications that need this first
primitive author the relevant routes with `defineChannel`. Factory exposure,
platform-specific rejection messages, and completed-control presentation can
be designed after the central contract is established.

Turn cancellation and session reset are also outside this proposal. They
require separate actor-bearing public APIs and distinct workflow ownership
rules; neither is added as a partially enforced gate.

## Alternatives considered

| Shape                                   | Why not                                                        |
| --------------------------------------- | -------------------------------------------------------------- |
| Gate every authored webhook route       | Conflates operation policy with request authentication         |
| Evaluate before resuming the workflow   | Observes stale state and can authorize the wrong token owner   |
| Fire-and-forget denial                  | The caller cannot distinguish denial from durable admission    |
| Gate only explicit input responses      | Text and dismissal paths bypass the same responder policy      |
| Store only descendant request ids       | Policy cannot inspect the request it is authorizing            |
| Expose gates on every factory now       | Couples the core contract to transport identity and UI choices |
| Add cancel and reset with optional auth | Creates an authorization surface without a reliable actor      |

The target-owned operation receipt is the smallest durable boundary that lets
policy observe current session state while preserving an awaited public
result.

## Observable invariants

- Initial session creation does not run a channel gate.
- Every configured gate returns an explicit allow or deny decision.
- A configured gate failure is unavailable, never implicit allowance.
- `session.resume` runs before `input.response`.
- Input policy sees the same normalized resolution that delivery applies.
- Descendant input policy receives full proxied requests.
- Every external delivery retains its own actor through gate evaluation.
- A denied operation changes no auth, adapter state, pending input, token,
  event stream, turn, or session status.
- Session policy runs at the workflow that owns authoritative state.
- A session cannot use a gate that it did not durably declare.
- Internal control-plane delivery bypasses channel gates.
- `channel.receive` runs only for proactive channel and schedule handoffs.
- Public unavailable errors reveal an opaque id, not the underlying exception.
- First-party channel factory APIs do not change.

## Resulting app API

```ts
defineChannel({
  gates?: {
    "session.resume"?: (
      input: SessionResumeGateInput,
      channel: Readonly<TContext>,
      ctx: ChannelGateContext,
    ) => ChannelGateDecision | Promise<ChannelGateDecision>;

    "input.response"?: (
      input: InputResponseGateInput,
      channel: Readonly<TContext>,
      ctx: ChannelGateContext,
    ) => ChannelGateDecision | Promise<ChannelGateDecision>;

    "channel.receive"?: (
      input: ReceiveInput<TReceiveTarget>,
      ctx: ChannelReceiveGateContext,
    ) => ChannelGateDecision | Promise<ChannelGateDecision>;
  };
});
```

The channel supplies authenticated actor context. The target workflow owns
session authorization and durable admission. The input layer owns one
normalized resolution. Proactive dispatch owns trusted source identity. Gates
decide policy without becoming another session lifecycle.
