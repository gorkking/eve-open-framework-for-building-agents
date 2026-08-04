---
issue: https://github.com/vercel/eve/issues/1580
status: proposed
last_updated: "2026-08-04"
---

# Unified session addressing and operations

## Decision

eve should expose two deliberately different handles over one session command
inbox:

- `ChannelAddress` targets whichever session owns a channel continuation token
  when an operation is invoked.
- `Session` targets one immutable durable session ID.

```text
ChannelAddress(continuationToken) ─┐
                                  ├─> one durable session command inbox
Session(sessionId) ────────────────┘
```

Both handles support `send`, `cancel`, `compact`, `clear`, and `reset`. The
difference is identity, not operation names:

```text
ChannelAddress.send() → resume current owner, or create when unowned
ChannelAddress.clear() → clear current owner, never create

Session.send()         → send to this exact ID, never create
Session.clear()        → clear this exact ID, never follow a replacement
```

No operation resolves a continuation token to a session ID and then resumes a
second hook. It dispatches one command through the address the caller already
has. Resolution exists only when code explicitly wants to convert a dynamic
`ChannelAddress` into a fixed `Session`.

A channel-created session owns two aliases for the same command inbox:

```text
<channel>:<continuationToken> ─┐
                              ├─> session command inbox
eve:session:<sessionId>:inbox ─┘
```

The channel alias may be rekeyed; the ID alias is stable until termination.
An HTTP-created session owns only the stable alias. All aliases must preserve
eve's committed-delivery, deduplication, cancellation, and durable-ordering
guarantees.

This is intentionally a breaking proposal.

## Identity model

| Identifier          | Meaning                                                       | Lifetime                                | May create                                      |
| ------------------- | ------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------- |
| `continuationToken` | Channel address whose current owner receives channel commands | May be rekeyed, released, and reclaimed | `ChannelAddress.send()` may create when unowned |
| `sessionId`         | Identity of one durable workflow session                      | Immutable                               | Never                                           |

The same channel address can identify different sessions over time:

```text
thread-123 → wrun_A
reset wrun_A
thread-123 → wrun_B
```

A handle for `wrun_A` never follows `thread-123` to `wrun_B`.

## Invariants

1. A `ChannelAddress` denotes a mutable channel routing address, not a session.
2. A `Session` always targets one immutable `sessionId`.
3. Every address operation is one command dispatch; none performs a
   resolve-then-dispatch sequence.
4. `ChannelAddress.send()` is the only resume-or-create operation.
5. Other `ChannelAddress` methods target the owner observed atomically when the
   command is accepted and never create.
6. No `Session` method creates or follows a continuation token.
7. A continuation token has at most one active owner.
8. Rekeying changes only the channel alias and cannot break ID operations.
9. Reset terminally retires the ID and releases every alias. Only a later
   `ChannelAddress.send()` or explicit HTTP create can create a replacement.
10. HTTP session operations use only `sessionId`; HTTP never accepts or returns
    a continuation token.
11. `resolveSession()` is an explicit identity conversion, not an operation
    prerequisite.
12. A function named `get` or `resolve` performs I/O; a handle factory is named
    `attach`.

## Operation semantics

| Operation                       | Address            | Creates         | Result when target is absent |
| ------------------------------- | ------------------ | --------------- | ---------------------------- |
| `ChannelAddress.send`           | Continuation token | Yes, if unowned | Creates and claims the token |
| `ChannelAddress.cancel`         | Continuation token | No              | `no_active_turn`             |
| `ChannelAddress.compact`        | Continuation token | No              | `no_active_session`          |
| `ChannelAddress.clear`          | Continuation token | No              | `no_active_session`          |
| `ChannelAddress.reset`          | Continuation token | No              | `no_active_session`          |
| `ChannelAddress.resolveSession` | Continuation token | No              | `undefined`                  |
| `Session.send`                  | Session ID         | No              | `session_not_active`         |
| `Session.cancel`                | Session ID         | No              | `no_active_turn`             |
| `Session.compact`               | Session ID         | No              | `no_active_session`          |
| `Session.clear`                 | Session ID         | No              | `no_active_session`          |
| `Session.reset`                 | Session ID         | No              | `no_active_session`          |
| Session stream                  | Session ID         | No              | Not found                    |

`ChannelAddress.send()` cannot create when the payload consists only of HITL
`inputResponses`; those responses are meaningful only to the session that
issued the request.

`cancel()`, `compact()`, and `clear()` remain asynchronous controls. Acceptance
means the command was durably queued. Awaited calls through the same address are
committed and processed in order, so sequential `await address.clear()` and
`await address.send(...)` calls cannot send before the clear. Stream events
confirm when the effects complete. `reset()` resolves only after the targeted
session is terminal and its aliases are released, so a subsequent channel send
cannot fall back into the retired owner.

## Public handles

### Fixed `Session`

The framework-side fixed session surface is:

```ts
interface Session {
  readonly id: string;

  send(input: SendInput, options: SessionSendOptions): Promise<SessionSendResult>;
  cancel(options?: { turnId?: string }): Promise<CancelResult>;
  compact(): Promise<CompactResult>;
  clear(): Promise<ClearResult>;
  reset(options?: { reason?: string }): Promise<ResetResult>;

  getEventStream(options?: StreamOptions): Promise<ReadableStream<MessageStreamEvent>>;
  getStreamTailIndex(): Promise<number>;
}
```

Every method is bound to `session.id`. `Session.continuationToken` is removed
because it is a moving channel address and is necessarily stale on some
fixed-ID handles.

Framework-side `Session.send()` requires the delivery auth context in
`SessionSendOptions`. Remote clients resolve auth from their configured HTTP
credentials instead. The accepted result may be wrapped by a transport-owned
turn/stream handle, but all surfaces retain the same ID-only target semantics.

Constructing a handle is not an existence check:

```ts
const session = attachSession("wrun_A");
```

The first operation reports whether the ID is active. Dynamic channel routing
is separate:

```ts
const thread = channelAddress("thread-123");
const current = await thread.resolveSession();
```

### Dynamic `ChannelAddress`

A `ChannelAddress` binds the channel-local continuation token once:

```ts
interface ChannelAddress<TState = undefined> {
  readonly continuationToken: string;

  send(input: SendInput, options: ChannelSendOptions<TState>): Promise<Session>;
  cancel(options?: { turnId?: string }): Promise<CancelResult>;
  compact(): Promise<CompactResult>;
  clear(): Promise<ClearResult>;
  reset(options?: { reason?: string }): Promise<ResetResult>;

  resolveSession(): Promise<Session | undefined>;
}
```

- `send()` delivers to the current owner or creates and claims the address.
- Controls dispatch directly to the current owner and never create.
- `resolveSession()` performs the optional token-to-fixed-ID conversion.

The distinction remains visible at the call site:

```ts
const thread = channelAddress(threadId);

const session = await thread.send("hello", { auth });
await thread.clear(); // current owner of threadId
await session.clear(); // exact session returned by send()
```

These two `clear()` calls normally target the same workflow, but encode
different intent if the address is later rekeyed or reclaimed. Free-floating
token control helpers are removed; the address object makes the dynamic target
explicit.

## Authoring shapes by surface

There are only two operation-bearing objects in author code:

```ts
const conversation = channelAddress(continuationToken);
// ChannelAddress → dispatchContinuation()
// Targets the owner of this address when each call is accepted.

const session = attachSession(sessionId);
// Session → dispatchSession()
// Always targets this exact durable session.
```

### Custom channel route

```ts
POST("/threads/:threadId/messages", async (request, { channelAddress, params }) => {
  const conversation = channelAddress(params.threadId);

  // Resume the current owner, or create and claim the address.
  const session = await conversation.send(await request.text(), {
    auth: null,
  });

  return Response.json({ sessionId: session.id });
});
```

All current-owner operations stay on the bound address and perform one command
resume:

```ts
const conversation = channelAddress(threadId);

await conversation.send("hello", { auth });
await conversation.cancel({ turnId });
await conversation.compact();
await conversation.clear();
await conversation.reset({ reason: "Start over" });
```

Use a fixed session only when the operation must not follow a replacement:

```ts
const conversation = channelAddress(threadId);

const session = await conversation.resolveSession(); // The only lookup.
if (session) {
  await session.send("hello", { auth });
  await session.cancel({ turnId });
  await session.compact();
  await session.clear();
  await session.reset({ reason: "Retire this exact session" });

  const stream = await session.getEventStream();
}

const attached = attachSession("wrun_A"); // No lookup.
```

The examples list the available operations; they are not intended as one
realistic sequence.

### Slack channel

Bound message and interaction handlers receive a `ChannelAddress` as
`ctx.conversation`:

```ts
async onAppMention(ctx) {
  // Available current-owner controls; choose the one needed by the handler.
  await ctx.conversation.cancel({ turnId });
  await ctx.conversation.compact();
  await ctx.conversation.clear();
  await ctx.conversation.reset({ reason: "Start over" });

  // The framework subsequently sends the inbound message through
  // ctx.conversation.send(message, { auth }). It does not resolve first.
  return { auth: null };
}
```

Resolve only to pin later work to the current durable session:

```ts
async onAppMention(ctx) {
  const session = await ctx.conversation.resolveSession();
  if (session) ctx.waitUntil(session.clear());
  return { auth: null };
}
```

Generic events construct a conversation from an explicit Slack target:

```ts
async onEvent(ctx) {
  const conversation = ctx.conversation({ channelId, threadTs });

  await conversation.cancel();
  await conversation.compact();
  await conversation.clear();
  await conversation.reset();

  const session = await ctx.receive({
    target: { channelId, threadTs },
    message: "hello",
    auth: null,
  });

  await session.send("follow-up", { auth: null });
}
```

These are independent operation examples. A handler would normally perform
only the control needed for that event.

### Other built-in platform channels

Discord, Teams, Telegram, Twilio, GitHub, Linear, Chat SDK, and Photon iMessage
use the same contract. A channel may expose the object under its natural noun,
but it remains a `ChannelAddress`:

```ts
const conversation = ctx.conversation; // or ctx.thread / ctx.chat

// Available operations; choose as needed.
await conversation.send(input, { auth });
await conversation.cancel();
await conversation.compact();
await conversation.clear();
await conversation.reset();

const session = await conversation.resolveSession();
```

Authored `receive` implementations convert the platform target into a
`ChannelAddress`, call `send`, and return the resulting `Session`.

### eve framework HTTP channel

The built-in HTTP channel never exposes or accepts a continuation token:

```http
POST /eve/v1/session
{"message":"hello"}

POST /eve/v1/session/wrun_A
{"message":"follow-up"}

POST /eve/v1/session/wrun_A/cancel
{"turnId":"turn_A"}

POST /eve/v1/session/wrun_A/compact
POST /eve/v1/session/wrun_A/clear

POST /eve/v1/session/wrun_A/reset
{"reason":"Start over"}

GET /eve/v1/session/wrun_A/stream
```

The create route calls `createSession()`. Every route containing `wrun_A`
dispatches or reads directly by that session ID; none calls
`resolveContinuation()`.

```http
HTTP/1.1 202 Accepted
{"sessionId":"wrun_A","status":"accepted"}
```

An unknown or terminal ID on the message route returns:

```http
HTTP/1.1 409 Conflict
{"code":"session_not_active"}
```

Send, compact, and clear acceptance use `202`. Cancel/reset completion and
benign inactive-control results use `200`. An unknown stream uses `404`.
Creation does not return until the stable command hook is registered, so an
immediate follow-up has no hook-readiness race.

### JavaScript HTTP client

```ts
const { session, response } = await client.sessions.create("hello");
await response.result();

await (await session.send("follow-up")).result();
await session.cancel({ turnId });
await session.compact();
await session.clear();
await session.reset({ reason: "Start over" });

for await (const event of session.stream()) {
  // ...
}
```

Attach to a known ID without I/O:

```ts
const session = client.sessions.attach("wrun_A");
```

```ts
interface ClientSessionState {
  readonly sessionId: string;
  readonly streamIndex: number;
}
```

The client stores no continuation token. Every method calls the corresponding
ID-only HTTP route. Reset leaves the handle pinned to its terminal ID; callers
discard it and explicitly create the replacement.

### TUI

```text
first prompt   → client.sessions.create(input)
later prompt   → session.send(input)
/cancel        → session.cancel()
Esc / Ctrl+C   → session.cancel()
/compact       → session.compact()
/clear         → session.clear()
/new           → session.clear()
/reset         → session.reset(); discard session
event loop     → session.stream()
```

The TUI has no `ChannelAddress`, continuation token, or resolution path.

### Cross-channel receive

```ts
const session = await args.receive(slack, {
  target: { channelId, threadTs },
  message: "Investigate this incident",
  auth,
});

// The returned fixed-session operations are available independently.
await session.send("Additional detail", { auth });
await session.cancel();
await session.compact();
await session.clear();
await session.reset();
```

The target channel implements `receive` with `ChannelAddress.send()`. The
caller receives a fixed `Session`, so subsequent operations cannot follow the
target address to a replacement.

### Framework translation

```ts
// ChannelAddress.send/cancel/compact/clear/reset
await runtime.dispatchContinuation({
  continuationToken,
  command,
});

// Session.send/cancel/compact/clear/reset
await runtime.dispatchSession({
  sessionId,
  command,
});

// ChannelAddress.resolveSession() only
await runtime.resolveContinuation(continuationToken);

// Session.getEventStream() / client session.stream()
await runtime.getEventStream(sessionId);
```

Only an unowned `ChannelAddress.send()` result enters `createSession()`.
Controls and all fixed-session methods never create.

## Channel lifecycle context

Lifecycle handlers already run inside the owning workflow. They receive
identity and channel routing state, not a recursive imperative session API:

```ts
interface ChannelEventContext<TPlatformContext> extends TPlatformContext {
  readonly session: {
    readonly id: string;
  };
  readonly continuation?: {
    readonly token: string;
    rekey(token: string): void;
  };
}
```

`continuation` is absent for transports such as the eve HTTP protocol that do
not own a channel address. Rekeying changes the channel alias while the stable
command hook remains active.

Top-level `continuationToken` and `setContinuationToken()` are removed in
favor of this explicit routing object.

## Runtime boundary

The runtime dispatches one command protocol through either address:

```ts
type SessionCommand =
  | {
      kind: "send";
      auth: SessionAuthContext | null;
      payload: DeliverPayload;
      requestId?: string;
    }
  | { kind: "cancel"; turnId?: string }
  | { kind: "compact" }
  | { kind: "clear" }
  | { kind: "reset"; reason?: string };

interface Runtime {
  createSession(input: CreateSessionInput): Promise<RunHandle>;

  dispatchContinuation(input: {
    continuationToken: string;
    command: SessionCommand;
  }): Promise<SessionCommandResult>;

  dispatchSession(input: {
    sessionId: string;
    command: SessionCommand;
  }): Promise<SessionCommandResult>;

  resolveContinuation(continuationToken: string): Promise<{ sessionId: string } | undefined>;

  getEventStream(
    sessionId: string,
    options?: StreamOptions,
  ): Promise<ReadableStream<MessageStreamEvent>>;
}
```

`dispatchContinuation()` resumes the channel hook with the command and returns
the owning `sessionId` from that resume. It does not call
`resolveContinuation()`. `dispatchSession()` computes the stable inbox token
from the supplied ID and performs the same single resume.

Only `ChannelAddress.send()` handles an unowned address by calling
`createSession()`. Every other command reports the appropriate inactive result.
Concurrent first sends must converge on one owner; an ownership conflict
retries command dispatch to the winner rather than surfacing a second session.

The current runtime-specific `deliver`, `cancelTurn`, `compactSession`,
`clearSession`, and `terminateSession` entry points collapse behind the two
dispatch methods. Streaming remains ID-addressed and read-only.

The low-level public route `Agent` interface is removed. Routes use
`ChannelAddress` and `Session`; framework internals use `Runtime`.

## Driver command inbox

The workflow driver creates its stable command hook before creation is
acknowledged. A channel-created session additionally owns one rekeyable alias
for the same command protocol.

```text
create HTTP session:
  create stable command hook
  acknowledge session

create channel session:
  create stable command hook
  claim channel alias
  acknowledge session

rekey channel session:
  claim new alias
  retire old alias
  keep stable command hook

reset:
  consume reset command
  dispose stable command hook
  dispose current alias
  terminate run
  acknowledge terminal state
```

The inbox multiplexes the stable hook, active alias, and already-committed
retired-alias commands into one durable queue. The driver continuously services
the inbox whether it is parked or supervising an active turn:

```text
send    → deliver to the turn, buffer, or start the next turn
cancel  → request cooperative cancellation of the active turn
compact → run compaction at the next valid driver boundary
clear   → clear model context at the next valid driver boundary
reset   → terminally retire the session and every alias
```

This replaces the split delivery, cancellation, and compact/clear hooks. A
command is consumed once regardless of which alias received it.

Internal hook tokens use a framework-reserved namespace that authored channel
tokens cannot claim.

`dispatchSession({ sessionId, command })` computes the internal stable token
locally:

```ts
resumeHook(sessionCommandHookToken(sessionId), command);
```

It never resolves a channel continuation token. Workflow still performs its
normal hook and run lookup while resuming that stable hook; ID-addressed here
describes eve's public identity semantics, not a new run-addressed Workflow
transport.

## Resolution cost

Resolution is not part of any operation path:

| Path                                      | Separate resolution | Command resumes |
| ----------------------------------------- | ------------------- | --------------- |
| `ChannelAddress.send()` to existing owner | None                | One             |
| Any `ChannelAddress` control              | None                | One             |
| Any `Session` operation                   | None                | One             |
| HTTP follow-up or control                 | None                | One             |
| Slack inbound send or control             | None                | One             |
| Explicit `resolveSession()`               | One lookup          | None            |

eve's current `resolveSession()` calls Workflow `getHookByToken()`, which also
fetches the run, resolves encryption state, and may hydrate hook metadata.
That is more work than identity resolution requires.

Workflow should expose a lightweight owner lookup:

```ts
getHookOwnerByToken(token): Promise<{ runId: string } | undefined>
```

In workflow-server, this can read the token-ownership constraint that already
stores `hookId` and `runId`, without fetching or hydrating the workflow run.
This optimization improves the explicit identity-conversion method but is not
placed on any command path.

Resuming either inbox alias still performs Workflow's normal hook-resume work.
A future atomic server-side resume endpoint may reduce its network round-trips,
but this proposal does not depend on that optimization.

## Race semantics

### Dynamic address versus fixed session

An address command targets the owner at command acceptance:

```text
thread-123 → wrun_A
thread.clear() → clears wrun_A

thread-123 → wrun_B
thread.clear() → clears wrun_B
```

Resolution freezes that observation into a fixed handle:

```ts
const session = await thread.resolveSession(); // Session(wrun_A)
// thread-123 is later reclaimed by wrun_B
await session?.clear(); // still targets wrun_A
```

### Reset then send

Address reset waits for the observed owner to terminate and release the alias:

```ts
await thread.reset();
const replacement = await thread.send("start again", { auth });
```

The send may create a replacement only after reset completes. A fixed old
handle remains terminal:

```ts
await oldSession.send("late", { auth }); // session_not_active
```

A delayed duplicate operation on `ChannelAddress` is intentionally dynamic and
may target a replacement. Code requiring duplicate safety resolves or retains
the fixed `Session` before scheduling the operation.

### Mismatched HTTP identity

The mismatch is impossible because HTTP carries one address:

```http
POST /eve/v1/session/wrun_A
{"message":"hello"}
```

There is no body token that can redirect delivery to `wrun_B`.

## Removed APIs

| Removed                                            | Replacement                                         |
| -------------------------------------------------- | --------------------------------------------------- |
| HTTP `continuationToken` fields                    | ID-only session routes                              |
| `ClientSessionState.continuationToken`             | `sessionId` and stream cursor                       |
| `client.session(token)`                            | `client.sessions.create()` or `.attach(sessionId)`  |
| `Session.continuationToken`                        | `ChannelAddress.continuationToken` where relevant   |
| Free token-addressed route helpers                 | Methods on one bound `ChannelAddress`               |
| `resolveActiveSession()` returning `{ sessionId }` | `ChannelAddress.resolveSession()`                   |
| Misnamed `getSession(sessionId)` facade            | `attachSession(sessionId)`                          |
| Slack bound and target-taking helpers              | Bound or constructed `ctx.conversation`             |
| Top-level lifecycle continuation fields            | `channel.continuation.token/rekey()`                |
| Public low-level `Agent`                           | `ChannelAddress`, `Session`, and internal `Runtime` |
| Split runtime delivery/control methods             | `dispatchContinuation` and `dispatchSession`        |

No deprecated aliases, fallback request parsing, or token-to-ID compatibility
paths remain.

## Verification

The implementation is complete only when tests prove these boundaries:

- ID delivery works during active turns and while the driver is parked.
- ID delivery never creates after reset, completion, failure, or unknown ID.
- Every address send/control performs one resume and never calls
  `resolveContinuation()`.
- Channel send remains resume-or-create and concurrent first sends produce one
  owner.
- Address cancel reaches an active turn through the shared command inbox.
- Rekey changes channel routing without interrupting ID delivery.
- Reset releases both delivery addresses; an old ID cannot reach a replacement.
- Commands committed to a retiring alias are consumed once.
- Address reset completes before a subsequent send can create a replacement.
- HTTP follow-up has no token field and cannot redirect or create.
- Slack performs no separate owner resolution unless handler code explicitly
  calls `resolveSession()`.
- A resolved Slack/custom-channel session remains pinned across replacement.
- Compact and clear are followed by successful address- and ID-addressed sends.
- TUI commands use the same ID-only client session and post-reset creation is
  explicit.
- Public docs and examples contain no token-bearing HTTP/client session state,
  free token helpers, or `getSession()` facade.

The HTTP e2e sequence should create, send, cancel, compact, clear, send again,
reset, reject an old-ID send, and explicitly create a replacement.

## Outcome

The complete model is:

```text
ChannelAddress: operate on the current owner of this channel address
Session: operate on this exact durable session
```

Every operation dispatches directly through one of those addresses. Resolution
is reserved for the deliberate transition from dynamic channel ownership to a
fixed session identity.
