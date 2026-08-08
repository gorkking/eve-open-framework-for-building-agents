/**
 * The provider contract authored under `agent/instrumentation/`.
 *
 * Reachable only with `experimental.instrumentationProviders` on. With the flag
 * off nothing discovers that directory, so these types compile but never run.
 */

// Type-only, so nothing couples the public entrypoint to the harness at
// runtime. The event shapes are eve's own vocabulary; deriving the handler map
// from the union below is what keeps the public contract from drifting away
// from the bus that feeds it.
import type { InstrumentationEvent } from "#harness/instrumentation-lifecycle.js";

export type {
  InstrumentationActionKind,
  InstrumentationAttemptScope,
  InstrumentationContentPart,
  InstrumentationEvent,
  InstrumentationModelCallCompletedEvent,
  InstrumentationModelCallFailedEvent,
  InstrumentationModelCallStartedEvent,
  InstrumentationModelRef,
  InstrumentationOperationRef,
  InstrumentationParentLineage,
  InstrumentationSessionFailedEvent,
  InstrumentationSessionSettledEvent,
  InstrumentationSessionStartedEvent,
  InstrumentationSessionTransitionEvent,
  InstrumentationStepAttemptMetadataEvent,
  InstrumentationStepAttemptCompletedEvent,
  InstrumentationStepAttemptFailedEvent,
  InstrumentationStepAttemptStartedEvent,
  InstrumentationStepAttemptTerminalEvent,
  InstrumentationToolCallCompletedEvent,
  InstrumentationToolCallFailedEvent,
  InstrumentationToolCallStartedEvent,
  InstrumentationToolOutput,
  InstrumentationTraceContext,
  InstrumentationTurnFailedEvent,
  InstrumentationTurnSettledEvent,
  InstrumentationTurnStartedEvent,
  InstrumentationTurnTerminalEvent,
  InstrumentationUsage,
} from "#harness/instrumentation-lifecycle.js";

/**
 * Marks a value as having come from `defineInstrumentation` or a built-in
 * factory.
 *
 * It does not say which layout the value belongs to: a provider and a legacy
 * config both carry `events` and `setup`, so no value-level check separates
 * them. The layout decides — `agent/instrumentation.ts` is read as a config and
 * `agent/instrumentation/*.ts` as providers, and the two are mutually exclusive
 * builds. The brand's job is only to catch a default export that never went
 * through eve at all.
 */
export const PROVIDER = Symbol.for("eve.instrumentation.provider");

/** Marks a slot the author turned off rather than configured. */
export const DISABLED = Symbol.for("eve.instrumentation.disabled");

/** Where the agent is running when `setup` fires. */
export type InstrumentationEnvironment = "development" | "preview" | "production";

/**
 * Passed to {@link InstrumentationProvider.setup} once at server startup,
 * before any event is published.
 */
export interface ProviderSetupContext {
  /** The agent name declared by `defineAgent`. */
  readonly agentName: string;
  readonly environment: InstrumentationEnvironment;
  /** The eve version running the agent. */
  readonly frameworkVersion: string;
}

/**
 * The second argument to every handler.
 *
 * Empty today. It exists now so adding durable per-provider state later is an
 * additive change rather than a second break in every handler signature.
 */
export type ProviderContext = Readonly<Record<never, never>>;

/**
 * One event handler.
 *
 * eve balances every start with exactly one terminal, so a handler that needs
 * to carry a value from a start to its terminal can key its own map on
 * `event.id` and delete on the terminal.
 */
export type Handler<TEvent> = (event: TEvent, ctx: ProviderContext) => void | PromiseLike<void>;

type EventForType<TEvent, TType> = TEvent extends { readonly type: infer TEventType }
  ? TType extends TEventType
    ? TEvent & { readonly type: TType }
    : never
  : never;

/**
 * The events a provider may handle, one optional handler per event type.
 *
 * Derived from the event union rather than written out, so a new event reaches
 * providers the moment the bus can publish it.
 */
export type ProviderEvents = {
  readonly [TType in InstrumentationEvent["type"]]?: Handler<
    EventForType<InstrumentationEvent, TType>
  >;
};

/**
 * What an author writes for one file under `agent/instrumentation/`.
 *
 * Handlers are dispatched in file order and failure-isolated: a handler that
 * throws is logged and the next provider still runs.
 */
export interface ProviderDefinition {
  readonly events?: ProviderEvents;
  /** Runs once at server startup, before any event is published. */
  readonly setup?: (context: ProviderSetupContext) => void | PromiseLike<void>;
  /** Drains anything buffered. eve calls this before a session goes idle. */
  readonly flush?: () => void | PromiseLike<void>;
  /** Releases resources when the process is going away. */
  readonly shutdown?: () => void | PromiseLike<void>;
}

/** A {@link ProviderDefinition} that has been through `defineInstrumentation`. */
export type InstrumentationProvider = ProviderDefinition & {
  readonly [PROVIDER]: true;
};

/** A slot the author turned off. eve registers nothing for it. */
export interface InstrumentationDisabled {
  readonly [DISABLED]: true;
}

/**
 * Turns off the slot the file it is exported from names.
 *
 * Export it as the default of `agent/instrumentation/local.ts` to stop eve
 * spooling local traces, for instance. Omitting the file entirely leaves eve's
 * default in place, which is why turning one off takes a value.
 */
export function disableInstrumentation(): InstrumentationDisabled {
  return { [DISABLED]: true };
}

export function isInstrumentationProvider(value: unknown): value is InstrumentationProvider {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<InstrumentationProvider>)[PROVIDER] === true
  );
}

export function isInstrumentationDisabled(value: unknown): value is InstrumentationDisabled {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<InstrumentationDisabled>)[DISABLED] === true
  );
}
