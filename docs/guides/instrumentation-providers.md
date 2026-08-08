---
title: "Instrumentation Providers"
description: "The experimental agent/instrumentation/ directory: one provider per file, the otel() and otelIntegration() split, per-destination content policy, and the lifecycle events providers handle."
---

Instrumentation providers replace the single `agent/instrumentation.ts` config object with a directory: `agent/instrumentation/`, one provider per file. A provider handles eve's lifecycle events, declares an OpenTelemetry destination, or both. Adding one destination no longer means taking responsibility for every other.

This is experimental and off by default. Turn it on in `defineAgent`:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-opus-4.8",
  experimental: {
    instrumentationProviders: true,
  },
});
```

The two layouts are mutually exclusive builds. With the flag off, an `instrumentation/` directory is a build error; with it on, a leftover `instrumentation.ts` is a build error. eve never silently picks one — telemetry that quietly does nothing is the failure this surface exists to prevent. For the shipped default layout, see [`instrumentation.ts`](./instrumentation).

## One provider per file

The filename is the slot name: `agent/instrumentation/otel.ts` fills the `otel` slot. Slots register in alphabetical order, so what a provider sees does not depend on how the filesystem enumerates the directory. Two files claiming one slot is an error.

```text
agent/instrumentation/
  otel.ts        the process-wide OpenTelemetry settings
  braintrust.ts  a destination
  local.ts       eve's local trace spool, reconfigured or turned off
  audit.ts       a provider that only handles events
```

Each file default-exports the result of `defineInstrumentation` or one of the built-in factories. A default export that never went through eve throws at server startup rather than being skipped.

```ts title="agent/instrumentation/audit.ts"
import { defineInstrumentation } from "eve/instrumentation";

export default defineInstrumentation({
  setup: ({ agentName, evaluation }) => {
    if (evaluation) return;
    console.log(`auditing ${agentName}`);
  },
  events: {
    "action.started": (event) => {
      console.log(event.kind, event.name);
    },
  },
});
```

## OpenTelemetry, in two halves

OpenTelemetry has one process-wide half and one plural half, and the directory splits them the same way.

`otel()` is the settings a process can only hold one of — a process has one tracer provider, so it has one resource, one sampler, and one propagator set. Declaring it twice is a boot error, which one file per slot makes structurally hard to do.

```ts title="agent/instrumentation/otel.ts"
import { otel } from "eve/instrumentation/otel";

export default otel({
  traceChannelRequests: true,
  resource: { "deployment.environment": process.env.VERCEL_ENV ?? "development" },
});
```

Omitting this file is the common case. eve registers the pipeline for whatever destinations are declared beside it; `otel()` only names what those destinations share.

`otelIntegration()` is a destination, and there may be as many as there are files. A `traceExporter` is wrapped in eve's batching processor, which is what makes the one-line form enough:

```ts title="agent/instrumentation/braintrust.ts"
import { BraintrustExporter } from "@braintrust/otel";
import { otelIntegration } from "eve/instrumentation/otel";

export default otelIntegration({
  traceExporter: new BraintrustExporter({ filterAISpans: true }),
});
```

Pass `spanProcessors` instead when the destination needs its own batching, sampling, or filtering. Both may be given: declared processors come first, and the wrapped exporter is appended after them.

`otel()` and `otelIntegration()` come from `eve/instrumentation/otel`, a separate entrypoint from `eve/instrumentation`.

## Content is per provider

A provider declares how much of each event it wants. The default is
`"metadata"`: structure, identity, usage, and timing, but not what the
conversation said. `"content"` adds the prompt, the response, tool arguments,
and tool results.

```ts title="agent/instrumentation/audit.ts"
export default defineInstrumentation({
  capture: "content",
  events: {
    "model.call.completed": (event) => {
      console.log(event.content);
    },
  },
});
```

Asking is what makes eve build the projection at all. A directory in which no
provider asked — and whose destinations all declined — never serializes a
prompt, so declining is cheaper than filtering as well as safer. Providers that
did not ask receive the same events with the content fields absent; a
`capture: "content"` provider beside them changes nothing about what they see.

Structure survives declining. `action.completed` still says whether the tool
returned or threw, and `model.call.completed` still carries its finish reason
and token usage — a provider counting failures or cost never has to ask for
content to get them.

Failure details and opaque provider metadata can contain prompts, tool output,
search queries, or retrieved text, so metadata providers do not receive them.
`step.attempt.metadata` keeps only the gateway cost and generation ID by
default; `capture: "content"` exposes the complete provider payload and failure
objects.

Content fields are therefore optional on the event types that carry them:
`input` on `model.call.started`, `action.started`, and `tool.call.started`;
`content` on `model.call.completed`; and the payloads inside action and tool-call
outputs.

## Content is per destination

`recordInputs` and `recordOutputs` belong to a destination, not to the process. Content is written onto a span if any destination wants it, and each destination that declined never exports it. A local spool and a hosted backend no longer have to agree:

```ts title="agent/instrumentation/braintrust.ts"
export default otelIntegration({
  traceExporter: new BraintrustExporter({ filterAISpans: true }),
  recordInputs: false,
  recordOutputs: false,
});
```

An agent whose every destination declines still never materializes a prompt — the OpenTelemetry pipeline is itself one provider, and a pipeline whose destinations all declined asks for `"metadata"` like any other. Declining wraps every processor in that file, an author's included: they are this destination, and the point of declining is that nothing under it sees what was said. The wrapper copies the span rather than editing it, because the span it is handed is shared with every other destination in the pipeline.

For sensitive, regulated, or production data, decline content on any destination whose retention path you have not reviewed. You are responsible for ensuring an observability or eval provider is approved for what is exported to it.

## Local traces

`eve dev` records spans to disk — one trace per session, read with [`/traces`](./dev-tui#inspect-traces) in the dev TUI or [`eve traces`](../reference/cli#eve-traces) in the terminal. Under the provider layout that spool is a destination like any other, and eve fills the `local` slot with it by default. Adding a hosted backend does not switch it off.

Say something about the slot only when you want to change it. `localTraces()` reconfigures it:

```ts title="agent/instrumentation/local.ts"
import { localTraces } from "eve/instrumentation/otel";

export default localTraces({ recordInputs: false });
```

`disableInstrumentation()` removes it:

```ts title="agent/instrumentation/local.ts"
import { disableInstrumentation } from "eve/instrumentation";

export default disableInstrumentation();
```

Omitting the file leaves eve's default in place, which is why turning one off takes a value rather than an absence. `EVE_TRACES_CONTENT=off` narrows this destination and no other, so declining content locally leaves what a hosted backend receives alone.

The spool is `eve dev` only: it writes under the dev worker's app root, and a deployed process has nowhere to put it.

## Agent Runs

On Vercel production, eve fills the reserved `agent-runs` slot with `agentRuns()` so the same canonical spans reach Agent Runs without an authored destination. Reconfigure it only when you need a narrower content policy:

```ts title="agent/instrumentation/agent-runs.ts"
import { agentRuns } from "eve/instrumentation/otel";

export default agentRuns({ recordInputs: false });
```

Export `disableInstrumentation()` from that file to turn Agent Runs off. Omitting the file leaves the production default in place.

## Lifecycle events

A provider's `events` map takes one handler per event type, each called with `(event, ctx)`:

| Event                                                                                            | Fires when                                                           |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `session.started`, `session.completed`, `session.waiting`, `session.failed`                      | A session begins, settles, parks for input, or fails                 |
| `turn.started`, `turn.completed`, `turn.cancelled`, `turn.failed`                                | A turn begins or reaches a terminal                                  |
| `step.attempt.started`, `step.attempt.completed`, `step.attempt.failed`, `step.attempt.metadata` | One model-call attempt within a turn                                 |
| `model.call.started`, `model.call.completed`, `model.call.failed`                                | The model call itself                                                |
| `action.started`, `action.completed`, `action.failed`                                            | Every eve dispatch: tool call, skill load, subagent, or remote agent |
| `tool.call.started`, `tool.call.completed`, `tool.call.failed`                                   | The AI SDK execution boundary for an ordinary tool call              |

An ordinary tool emits both families. `action.*` is eve's durable dispatch
boundary and covers work that can settle in another worker; `tool.call.*` is the
model SDK's in-process execution boundary. Handle one unless you intentionally
want both views.

Every event carries an `idempotencyKey` naming the operation it is about. A start and its terminal share a key when the terminal arrives. An incomplete model stream can close without one, so live resources need step-attempt cleanup or their own expiry.

Handlers are dispatched in slot order and failure-isolated: one that throws is logged and the next provider still runs.

### Carrying a value across a handler pair

`ctx.state` is durable storage scoped to one provider and one operation. Two providers reacting to the same event cannot see or overwrite each other, and one provider's turns and actions stay separate.

A terminal event names the operation it settles but not what that operation was — `action.completed` carries the output, while `kind` and `name` were on `action.started`. Carrying either across the pair is what state is for:

```ts title="agent/instrumentation/timing.ts"
import { defineInstrumentation } from "eve/instrumentation";

export default defineInstrumentation({
  events: {
    "action.started": (event, ctx) => {
      ctx.state.set({ name: event.name, startedAt: Date.now() });
    },
    "action.completed": (_event, ctx) => {
      // `get` returns `JsonValue`, which cannot know the shape you wrote.
      const started = ctx.state.get() as { name: string; startedAt: number } | undefined;
      if (started === undefined) return;
      console.log(`${started.name} took ${Date.now() - started.startedAt}ms`);
    },
  },
});
```

`set` is synchronous because it stages into the durable context eve commits when the step settles, rather than writing to a store of its own. That is also why the value must survive JSON — a value that cannot throws at `set` rather than at the step boundary. Writes after the handler settles or times out are ignored.

State survives a step boundary. An approval-gated tool suspends and resumes in a different process, and a value written at `action.started` is still readable at `action.completed` there — which a module-level `Map` would not be. eve releases the slot when that terminal arrives.

### Handler timeouts

Dispatch is sequential and awaited, so a handler that never settles would stop the bus for everything behind it. When any handler exceeds eve's timeout the bus moves on. If it was a `*.started` handler, the operation is durably abandoned for that provider and its later terminal is withheld, even in another worker. Point and terminal handler timeouts do not abandon the operation, and late state writes are ignored.

## Setup, flush, and shutdown

`setup` runs once at server startup, before any event is published, and eve awaits it — a provider cannot miss an event published while it is still starting up.

```ts
setup: ({ agentName, environment, evaluation, frameworkVersion }) => {
  console.log(evaluation?.runId);
};
```

`evaluation` contains `{ runId }` when the server exists to serve a local `eve eval` run. Eval traffic is synthetic, so providers can associate or exclude it. The field is absent for ordinary servers and for a server that `eve eval --url` merely points at: that process cannot claim one remote caller's run as its own.

`setup` is not where an OpenTelemetry pipeline gets registered. The pipeline is the union of every destination in the directory, so no single file knows enough to build it; a `setup` that reaches for a tracer gets the no-op one. Declare destinations as values and let eve assemble them.

`flush` drains anything buffered, and eve calls it when a step settles — including when a session suspends, which on a serverless host is the last moment a buffered exporter can still reach the network. `shutdown` releases resources when the process is going away.

## What to read next

- [`instrumentation.ts`](./instrumentation): the shipped default layout, workflow run tags, and Agent Runs
- [Hooks](./hooks): observe the runtime event stream
- [`agent.ts`](../agent-config): where `experimental` lives
