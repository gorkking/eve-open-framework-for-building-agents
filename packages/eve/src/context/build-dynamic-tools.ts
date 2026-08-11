import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { ContextReader } from "#context/key.js";
import {
  SessionDynamicToolMetadataKey,
  TurnDynamicToolMetadataKey,
  LiveSessionToolsKey,
  LiveStepToolsKey,
} from "#context/keys.js";
import type { DurableDynamicToolMetadata } from "#context/keys.js";
import { requiresLiveDynamicTool } from "#context/dynamic-tool-metadata.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import { createLogger } from "#internal/logging.js";
import type { ApprovalContext, ApprovalStatus } from "#public/definitions/approval.js";
import { toInputSchema, toOutputSchema } from "#shared/tool-schema.js";

const log = createLogger("dynamic-tools");

function lookupStepFunction(stepId: string): ((...args: unknown[]) => unknown) | null {
  try {
    const registry = (globalThis as Record<symbol, Map<string, Function> | undefined>)[
      Symbol.for("@workflow/core//registeredSteps")
    ];
    if (registry === undefined) return null;
    const fn = registry.get(stepId);
    return fn ? (fn as (...args: unknown[]) => unknown) : null;
  } catch {
    return null;
  }
}

function replayTools(metadata: readonly DurableDynamicToolMetadata[]): HarnessToolDefinition[] {
  const tools: HarnessToolDefinition[] = [];

  for (const m of metadata) {
    if (!m.executeStepFnName || !m.closureVars) {
      log.warn(
        `Dynamic tool "${m.name}" has no registered step function — ` +
          "skipping on this step. The bundler transform may not have processed this tool file.",
      );
      continue;
    }

    const stepFn = lookupStepFunction(m.executeStepFnName);
    if (!stepFn) {
      log.warn(
        `Dynamic tool "${m.name}" references step function "${m.executeStepFnName}" ` +
          "which is not registered — skipping on this step.",
      );
      continue;
    }

    tools.push({
      description: m.description,
      execute: createToolExecuteWithAuth({
        scope: m.name,
        execute: (input, ctx) => stepFn(m.closureVars, input, ctx),
      }),
      inputSchema: toInputSchema(m.inputSchema),
      name: m.name,
      approval: buildReplayedApproval(m),
      outputSchema: toOutputSchema(m.outputSchema),
    });
  }

  return tools;
}

function buildSessionTools(ctx: ContextReader): HarnessToolDefinition[] {
  const metadata = ctx.get(SessionDynamicToolMetadataKey) ?? [];
  const liveByName = new Map((ctx.get(LiveSessionToolsKey) ?? []).map((tool) => [tool.name, tool]));
  const replayedByName = new Map(
    replayTools(metadata.filter((entry) => !requiresLiveDynamicTool(entry))).map((tool) => [
      tool.name,
      tool,
    ]),
  );

  return metadata.flatMap((entry) => {
    const tool = liveByName.get(entry.name) ?? replayedByName.get(entry.name);
    return tool === undefined ? [] : [tool];
  });
}

function buildReplayedApproval(
  metadata: DurableDynamicToolMetadata,
): HarnessToolDefinition["approval"] | undefined {
  if (metadata.approvalStepFnName === undefined) {
    return undefined;
  }

  const approvalStepFn = lookupStepFunction(metadata.approvalStepFnName);
  if (approvalStepFn === null) {
    log.warn(
      `Dynamic tool "${metadata.name}" references approval function "${metadata.approvalStepFnName}" ` +
        "which is not registered — requiring approval by default.",
    );
    return () => "user-approval";
  }

  return async (approvalCtx: ApprovalContext) =>
    (await approvalStepFn(metadata.closureVars ?? {}, approvalCtx)) as ApprovalStatus;
}

/**
 * Builds live dynamic tool definitions. Narrower scopes appear first
 * so they win on name collision (the tool-loop uses `??=` for dedup).
 *
 * Step tools are live closures (re-resolved every step via
 * `LiveStepToolsKey`). Session tools that carry process-local callbacks
 * use live definitions; other session and turn tools replay durable metadata.
 */
export function buildDynamicTools(ctx: ContextReader): readonly HarnessToolDefinition[] {
  const step = ctx.get(LiveStepToolsKey) ?? [];
  const turn = replayTools(ctx.get(TurnDynamicToolMetadataKey) ?? []);
  const session = buildSessionTools(ctx);
  return [...step, ...turn, ...session];
}
