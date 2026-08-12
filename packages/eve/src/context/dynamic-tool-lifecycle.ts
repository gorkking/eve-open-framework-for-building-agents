import type { ModelMessage } from "ai";

import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import {
  resolveApprovalPolicy,
  type ApprovalContext,
  type ApprovalResponseContext,
} from "#public/definitions/approval.js";
import type { DynamicToolEntry } from "#shared/dynamic-tool-definition.js";
import type { SessionStartedStreamEvent, UnstampedMessageStreamEvent } from "#protocol/message.js";
import {
  ALLOWED_DYNAMIC_TOOL_EVENTS,
  isBrandedToolEntry,
} from "#shared/dynamic-tool-definition.js";
import type { ResolvedDynamicToolResolver } from "#runtime/types.js";
import { createLogger } from "#internal/logging.js";
import {
  serializeInputSchema,
  serializeOutputSchema,
  toInputSchema,
  toOutputSchema,
} from "#shared/tool-schema.js";
import { toErrorMessage } from "#shared/errors.js";
import type { AlsContext } from "#context/container.js";
import type { ContextKey } from "#context/key.js";
import {
  SessionDynamicToolMetadataKey,
  SessionDynamicToolRuntimeRevisionKey,
  TurnDynamicToolMetadataKey,
  LiveStepToolsKey,
} from "#context/keys.js";
import type { DurableDynamicToolMetadata } from "#context/keys.js";
import { buildResolveContext } from "#context/dynamic-resolve-context.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import { replayDurableTools } from "#context/build-dynamic-tools.js";

const log = createLogger("dynamic-tools");

// ---------------------------------------------------------------------------
// Tool entry conversion
// ---------------------------------------------------------------------------

function toHarnessToolDefinition(name: string, entry: DynamicToolEntry): HarnessToolDefinition {
  return {
    description: entry.description,
    execute: createToolExecuteWithAuth({
      scope: name,
      execute: (input, ctx) =>
        entry.execute(input as Record<string, unknown>, ctx as Parameters<typeof entry.execute>[1]),
    }),
    inputSchema: toInputSchema(entry.inputSchema),
    name,
    approval: entry.approval,
    outputSchema: toOutputSchema(entry.outputSchema),
    ...(entry.toModelOutput !== undefined
      ? { toModelOutput: entry.toModelOutput as (output: unknown) => unknown }
      : {}),
  };
}

function qualifyDynamicToolNames(
  resolver: ResolvedDynamicToolResolver,
  isSingle: boolean,
  entries: Readonly<Record<string, DynamicToolEntry>>,
): Array<{ name: string; entryKey: string; entry: DynamicToolEntry }> {
  const keys = Object.keys(entries);
  const result: Array<{ name: string; entryKey: string; entry: DynamicToolEntry }> = [];

  if (keys.length === 0) return result;

  // A single returned defineTool is named after the file slug; a map names each
  // entry by its bare key (authors namespace keys themselves if needed).
  if (isSingle) {
    result.push({ name: resolver.slug, entryKey: keys[0]!, entry: entries[keys[0]!]! });
    return result;
  }

  // Map entries from an extension resolver are prefixed with the mount
  // namespace so extension-produced tools are namespaced like the extension's
  // static tools. The single-tool case above already uses the namespaced slug.
  const prefix =
    resolver.extensionNamespace !== undefined ? `${resolver.extensionNamespace}__` : "";
  for (const key of keys) {
    result.push({ name: `${prefix}${key}`, entryKey: key, entry: entries[key]! });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tool replay from durable metadata
// ---------------------------------------------------------------------------

/**
 * Reconstructs tool definitions from durable metadata using
 * registered step functions. No resolver re-invocation — the
 * execute function is looked up by step ID and called with stored
 * closure vars.
 */
export function replayDynamicSessionTools(
  metadata: readonly DurableDynamicToolMetadata[],
  _resolvers: readonly ResolvedDynamicToolResolver[],
): readonly HarnessToolDefinition[] {
  return replayDurableTools(metadata);
}

// ---------------------------------------------------------------------------
// Step function lookup + serialization helpers
// ---------------------------------------------------------------------------

function getStepRegistry(): Map<string, Function> {
  const key = Symbol.for("@workflow/core//registeredSteps");
  const g = globalThis as Record<symbol, Map<string, Function> | undefined>;
  let registry = g[key];
  if (registry === undefined) {
    registry = new Map();
    g[key] = registry;
  }
  return registry;
}

function registerStepFunction(stepId: string, fn: Function): void {
  getStepRegistry().set(stepId, fn);
}

function safeSerialize(obj: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Scoped key routing
// ---------------------------------------------------------------------------

function durableKeyForEvent(
  eventType: string,
): ContextKey<readonly DurableDynamicToolMetadata[]> | undefined {
  switch (eventType) {
    case "session.started":
      return SessionDynamicToolMetadataKey;
    case "turn.started":
      return TurnDynamicToolMetadataKey;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Build: assemble live tools from all scoped durable keys
// ---------------------------------------------------------------------------

/**
 * Builds live dynamic tool definitions from session + turn + step
 * durable metadata keys. Session-scoped tools appear first, then
 * turn, then step. The tool-loop calls this right before the model
 * call — no virtual key needed.
 */
// ---------------------------------------------------------------------------
// Resolve: run resolver handlers, capture closures, write durable metadata
// ---------------------------------------------------------------------------

interface ResolveResult {
  readonly metadata: readonly DurableDynamicToolMetadata[];
  readonly liveTools: readonly HarnessToolDefinition[];
}

function readDynamicToolResult(
  resolver: ResolvedDynamicToolResolver,
  value: unknown,
): { readonly entries: Record<string, DynamicToolEntry>; readonly isSingle: boolean } {
  if (isBrandedToolEntry(value)) {
    return { entries: { _single: value as DynamicToolEntry }, isSingle: true };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `Dynamic tool resolver "${resolver.logicalPath}" must return defineTool(), a map of defineTool() values, or null.`,
    );
  }

  const entries: Record<string, DynamicToolEntry> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!isBrandedToolEntry(entry)) {
      throw new Error(
        `Dynamic tool resolver "${resolver.logicalPath}" returned "${name}" without defineTool(). Wrap every dynamic tool entry in defineTool().`,
      );
    }
    entries[name] = entry as DynamicToolEntry;
  }
  return { entries, isSingle: false };
}

async function resolveToolsFromEvent(
  ctx: AlsContext,
  resolvers: readonly ResolvedDynamicToolResolver[],
  event: UnstampedMessageStreamEvent,
  messages: readonly ModelMessage[],
  abortSignal: AbortSignal,
): Promise<ResolveResult> {
  const outcomes = await Promise.allSettled(
    resolvers.map(async (resolver) => {
      const handler = resolver.events[event.type];
      if (handler === undefined) return null;

      const resolveCtx =
        resolver.buildContext === undefined
          ? buildResolveContext(ctx, messages)
          : resolver.buildContext({ abortSignal, messages });
      if (resolveCtx === null) return null;
      const rawResult = await handler(event, resolveCtx);
      if (rawResult === null || rawResult === undefined) return null;
      const { entries, isSingle } = readDynamicToolResult(resolver, rawResult);
      return { resolver, entries, isSingle };
    }),
  );

  const metadata: DurableDynamicToolMetadata[] = [];
  const liveTools: HarnessToolDefinition[] = [];
  // Tracks which resolver claimed each name so two dynamic resolvers can't
  // silently shadow each other (a dynamic tool overriding an authored one is
  // allowed and handled at merge time).
  const dynamicToolOwners = new Map<string, string>();

  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      log.error(`Dynamic tool resolver (${event.type}) threw — skipping.`, {
        error: toErrorMessage(outcome.reason),
      });
      continue;
    }
    if (outcome.value === null) continue;

    const { resolver, entries, isSingle } = outcome.value;
    const named = qualifyDynamicToolNames(resolver, isSingle, entries);
    for (const { name, entryKey, entry } of named) {
      const previousOwner = dynamicToolOwners.get(name);
      if (previousOwner !== undefined && previousOwner !== resolver.slug) {
        throw new Error(
          `Dynamic tool "${name}" from resolver "${resolver.slug}" collides with dynamic resolver "${previousOwner}". Namespace the map key manually, e.g. "${resolver.slug}__${name}".`,
        );
      }
      dynamicToolOwners.set(name, resolver.slug);

      liveTools.push(toHarnessToolDefinition(name, entry));
      if (event.type === "step.started") {
        continue;
      }

      const stepFn =
        "__executeStepFn" in entry
          ? (entry as { __executeStepFn?: { stepId?: string } }).__executeStepFn
          : undefined;
      const closureVars =
        "__closureVars" in entry
          ? (entry as { __closureVars?: Record<string, unknown> }).__closureVars
          : undefined;

      let executeStepFnName = stepFn?.stepId;
      let serializedClosureVars =
        closureVars !== undefined ? safeSerialize(closureVars) : undefined;

      if (executeStepFnName === undefined || serializedClosureVars === undefined) {
        executeStepFnName = `eve:framework-dynamic:${resolver.slug}:${entryKey}`;
        const originalExecute = entry.execute.bind(entry);
        registerStepFunction(
          executeStepFnName,
          (_closureVars: unknown, input: unknown, context: unknown) =>
            originalExecute(
              input as Record<string, unknown>,
              context as Parameters<typeof entry.execute>[1],
            ),
        );
        serializedClosureVars = {};
      }

      let approvalStepFnName: string | undefined;
      let approvalResponseStepFnName: string | undefined;
      if (entry.approval !== undefined) {
        approvalStepFnName = `eve:dynamic-tool-approval:${resolver.slug}:${entryKey}`;
        const originalApproval = resolveApprovalPolicy(entry.approval).bind(entry);
        registerStepFunction(approvalStepFnName, (_closureVars: unknown, approvalCtx: unknown) =>
          originalApproval(approvalCtx as ApprovalContext),
        );

        const responsePolicy =
          typeof entry.approval === "function" ? undefined : entry.approval.response;
        if (responsePolicy !== undefined) {
          approvalResponseStepFnName = `eve:dynamic-tool-approval-response:${resolver.slug}:${entryKey}`;
          registerStepFunction(
            approvalResponseStepFnName,
            (_closureVars: unknown, responseCtx: unknown) =>
              responsePolicy(responseCtx as ApprovalResponseContext),
          );
        }
      }

      let toModelOutputStepFnName: string | undefined;
      if (entry.toModelOutput !== undefined) {
        toModelOutputStepFnName = `eve:dynamic-tool-model-output:${resolver.slug}:${entryKey}`;
        const originalToModelOutput = entry.toModelOutput.bind(entry);
        registerStepFunction(toModelOutputStepFnName, (_closureVars: unknown, output: unknown) =>
          originalToModelOutput(output),
        );
      }

      metadata.push({
        name,
        description: entry.description,
        inputSchema: serializeInputSchema(entry.inputSchema),
        outputSchema: serializeOutputSchema(entry.outputSchema),
        resolverSlug: resolver.slug,
        entryKey,
        executeStepFnName,
        approvalStepFnName,
        approvalResponseStepFnName,
        closureVars: serializedClosureVars,
        toModelOutputStepFnName,
      });
    }
  }

  return { metadata, liveTools };
}

// ---------------------------------------------------------------------------
// Dispatch: route to the scope-appropriate durable key
// ---------------------------------------------------------------------------

const resolvedStepTools = new WeakMap<
  AlsContext,
  { readonly coordinate: string; readonly tools: readonly HarnessToolDefinition[] }
>();

/**
 * Dispatches a stream event to dynamic tool resolvers. Each
 * resolver's metadata replaces its slot (by slug) in the
 * scope-appropriate durable key. The tool-loop calls
 * {@link buildDynamicTools} to assemble the effective toolset.
 */
/** Resolves step-scoped tools once for one internal policy/model pass. */
export async function resolveStepDynamicTools(input: {
  readonly abortSignal: AbortSignal;
  readonly ctx: AlsContext;
  readonly resolvers: readonly ResolvedDynamicToolResolver[];
  readonly event: UnstampedMessageStreamEvent;
  readonly messages: readonly ModelMessage[];
}): Promise<void> {
  const data = ("data" in input.event ? input.event.data : undefined) as
    | { readonly stepIndex?: unknown; readonly turnId?: unknown }
    | undefined;
  const coordinate =
    typeof data?.turnId === "string" && typeof data.stepIndex === "number"
      ? `${data.turnId}:${String(data.stepIndex)}`
      : undefined;
  const cached = resolvedStepTools.get(input.ctx);
  if (coordinate !== undefined && cached?.coordinate === coordinate) {
    input.ctx.setVirtualContext(LiveStepToolsKey, cached.tools);
    return;
  }

  const matching = input.resolvers.filter((resolver) =>
    resolver.eventNames.includes("step.started"),
  );
  const { liveTools } =
    matching.length === 0
      ? { liveTools: [] }
      : await resolveToolsFromEvent(
          input.ctx,
          matching,
          input.event,
          input.messages,
          input.abortSignal,
        );
  input.ctx.setVirtualContext(LiveStepToolsKey, liveTools);
  if (coordinate !== undefined) {
    resolvedStepTools.set(input.ctx, { coordinate, tools: liveTools });
  }
}

export async function dispatchDynamicToolEvent(input: {
  readonly abortSignal: AbortSignal;
  readonly ctx: AlsContext;
  readonly resolvers: readonly ResolvedDynamicToolResolver[];
  readonly event: UnstampedMessageStreamEvent;
  readonly messages: readonly ModelMessage[];
}): Promise<void> {
  const { abortSignal, ctx, resolvers, event, messages } = input;

  if (!ALLOWED_DYNAMIC_TOOL_EVENTS.has(event.type)) return;

  if (event.type === "step.started") {
    await resolveStepDynamicTools(input);
    return;
  }

  const matching = resolvers.filter((r) => r.eventNames.includes(event.type));
  if (matching.length === 0) {
    if (event.type === "session.started") {
      ctx.set(SessionDynamicToolMetadataKey, []);
    }
    return;
  }

  const { metadata } = await resolveToolsFromEvent(ctx, matching, event, messages, abortSignal);

  // Session/turn: store durable metadata for cross-step replay via
  // the bundler's registered step functions.
  const durableKey = durableKeyForEvent(event.type);
  if (durableKey === undefined) return;

  if (event.type === "session.started") {
    ctx.set(SessionDynamicToolMetadataKey, metadata);
    return;
  }

  const slugs = new Set(matching.map((r) => r.slug));
  const existing = ctx.get(durableKey) ?? [];
  const kept = existing.filter((m) => !slugs.has(m.resolverSlug));
  ctx.set(durableKey, [...kept, ...metadata]);
}

/**
 * Re-resolves session-scoped dynamic tools when a durable session reaches a
 * different runtime revision. The refresh is internal: lifecycle consumers
 * still observe exactly one `session.started` event for the session.
 */
export async function refreshDynamicSessionToolsForRuntimeRevision(input: {
  readonly abortSignal: AbortSignal;
  readonly ctx: AlsContext;
  readonly resolvers: readonly ResolvedDynamicToolResolver[];
  readonly event: SessionStartedStreamEvent;
  readonly messages: readonly ModelMessage[];
  readonly runtimeRevision: string;
}): Promise<void> {
  if (input.ctx.get(SessionDynamicToolRuntimeRevisionKey) === input.runtimeRevision) {
    return;
  }

  const matching = input.resolvers.filter((resolver) =>
    resolver.eventNames.includes("session.started"),
  );
  const { metadata } =
    matching.length === 0
      ? { metadata: [] }
      : await resolveToolsFromEvent(
          input.ctx,
          matching,
          input.event,
          input.messages,
          input.abortSignal,
        );

  input.ctx.set(SessionDynamicToolMetadataKey, metadata);
  input.ctx.set(SessionDynamicToolRuntimeRevisionKey, input.runtimeRevision);
}
