import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { SettledTurn } from "#harness/types.js";
import type { TokenUsage } from "#shared/token-usage.js";

/** Result of one durable harness step. */
export type DurableStepResult =
  | {
      readonly action: "continue" | "done";
      readonly output?: unknown;
      readonly isError?: boolean;
      readonly sleepDurationMs?: number;
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
      /** Session-total token usage; set on `done` when the session spent any. */
      readonly usage?: TokenUsage;
      /** Usage the final turn added beyond earlier settled turns. */
      readonly usageDelta?: TokenUsage;
    }
  | {
      readonly action: "cancelled";
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
    }
  | {
      readonly action: "park";
      readonly authorizationAttemptIds?: readonly string[];
      readonly authorizationNames?: readonly string[];
      readonly hasPendingAuthorization: boolean;
      readonly hasPendingInputBatch: boolean;
      readonly pendingRuntimeActionKeys?: readonly string[];
      /** Selects task dispatch when the agent runs `experimental.tasks`. */
      readonly tasksEnabled?: boolean;
      readonly sleepDurationMs?: number;
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
      readonly settled?: SettledTurn;
    }
  | {
      readonly action: "dispatch-workflow-runtime-actions";
      readonly pendingRuntimeActionKeys: readonly string[];
      readonly sleepDurationMs?: number;
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
    };
