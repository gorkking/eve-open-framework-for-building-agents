import { randomUUID } from "node:crypto";

import { z } from "#compiled/zod/index.js";

import { loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import { requireSandboxSession } from "#execution/sandbox/require-sandbox.js";
import { setApprovalPresentation } from "#harness/approval-presentation.js";
import type { ApprovalContext, ApprovalStatus } from "#public/definitions/approval.js";
import { normalizeModelPath } from "#runtime/framework-tools/file-state.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";
import type { SandboxSession } from "#shared/sandbox-session.js";
import type { SourceEditChange, SourceEditProposal } from "#shared/source-edit-proposal.js";
import type { ToolExecuteOptions } from "#shared/tool-definition.js";

export const PROPOSE_EDITS_TOOL_NAME = "propose_edits";
export const APPLY_EDITS_TOOL_NAME = "apply_edits";

const FILE_PATH_SCHEMA = z
  .string()
  .describe("Absolute path under /workspace for the file being changed.");

const EDIT_SCHEMA = z.discriminatedUnion("kind", [
  z.strictObject({
    content: z.string().describe("Complete contents for the new file."),
    filePath: FILE_PATH_SCHEMA,
    kind: z.literal("create"),
  }),
  z.strictObject({
    filePath: FILE_PATH_SCHEMA,
    kind: z.literal("replace"),
    newText: z.string().describe("Replacement text."),
    oldText: z.string().min(1).describe("Existing text that must occur exactly once."),
  }),
  z.strictObject({
    filePath: FILE_PATH_SCHEMA,
    kind: z.literal("delete"),
  }),
]);

const PROPOSE_EDITS_INPUT_SCHEMA = z.strictObject({
  edits: z.array(EDIT_SCHEMA).min(1).describe("The complete set of proposed file edits."),
  summary: z.string().min(1).describe("A concise explanation of the proposed change."),
});

const PROPOSAL_REFERENCE_SCHEMA = z.strictObject({
  proposalId: z.string().uuid(),
});

const APPLY_EDITS_OUTPUT_SCHEMA = z.strictObject({
  changedFiles: z.array(z.string()),
  proposalId: z.string(),
});

export type ProposedEdit = z.infer<typeof EDIT_SCHEMA>;
export type SourceEditProposalReference = z.infer<typeof PROPOSAL_REFERENCE_SCHEMA>;

type SelfmodEditSandbox = Pick<SandboxSession, "readTextFile" | "removePath" | "writeTextFile">;

type SelfmodEditState = {
  readonly proposals: Readonly<Record<string, SourceEditProposal>>;
};

const SelfmodEditStateKey = new ContextKey<SelfmodEditState>("eve.selfmodEdits");

function normalizeWorkspacePath(filePath: string): string {
  if (!filePath.startsWith("/")) {
    throw new Error(`Self-modification path must be absolute: ${filePath}`);
  }
  const normalized = normalizeModelPath(filePath);
  if (!normalized.startsWith("/workspace/")) {
    throw new Error(`Self-modification path must be under /workspace: ${filePath}`);
  }
  return normalized;
}

function requirePendingProposal(proposalId: string): SourceEditProposal {
  const proposal = loadContext().get(SelfmodEditStateKey)?.proposals[proposalId];
  if (proposal === undefined) {
    throw new Error(`Unknown or expired edit proposal: ${proposalId}`);
  }
  return proposal;
}

function requestApplyEditsApproval(ctx: ApprovalContext): ApprovalStatus {
  try {
    const { proposalId } = PROPOSAL_REFERENCE_SCHEMA.parse(ctx.toolInput);
    const proposal = requirePendingProposal(proposalId);
    setApprovalPresentation(ctx.session.id, ctx.callId, {
      prompt: "Review the proposed edits. Approve to apply these exact changes.",
      sourceDiff: {
        changedBytes: proposal.changes.reduce(
          (total, [, before, after]) =>
            total + Buffer.byteLength(before ?? "") + Buffer.byteLength(after ?? ""),
          0,
        ),
        files: proposal.changes.map(([path, before, after]) => ({
          after,
          before,
          path,
          status: before === null ? "create" : after === null ? "delete" : "modify",
        })),
        kind: "source-diff",
      },
    });
    return "user-approval";
  } catch (error) {
    return {
      type: "denied",
      reason: error instanceof Error ? error.message : "The proposed edits cannot be reviewed.",
    };
  }
}

/** Finalizes and records edits without changing the sandbox filesystem. */
export async function proposeEdits(
  sandbox: SelfmodEditSandbox,
  input: z.infer<typeof PROPOSE_EDITS_INPUT_SCHEMA>,
): Promise<SourceEditProposalReference> {
  const paths = new Set<string>();
  const normalizedPaths = input.edits.map((edit) => {
    const path = normalizeWorkspacePath(edit.filePath);
    if (paths.has(path)) {
      throw new Error(`A proposal may edit each file only once: ${path}`);
    }
    paths.add(path);
    return path;
  });
  const currentContents = await Promise.all(
    normalizedPaths.map((path) => sandbox.readTextFile({ path })),
  );
  const changes: SourceEditChange[] = input.edits.map((edit, index) => {
    const path = normalizedPaths[index]!;
    const current = currentContents[index] ?? null;
    if (edit.kind === "create") {
      if (current !== null) {
        throw new Error(`Cannot create ${path} because it already exists.`);
      }
      return [path, null, edit.content];
    }
    if (current === null) {
      throw new Error(`Cannot ${edit.kind} ${path} because it does not exist.`);
    }
    if (edit.kind === "delete") return [path, current, null];

    const first = current.indexOf(edit.oldText);
    const second = first < 0 ? -1 : current.indexOf(edit.oldText, first + edit.oldText.length);
    if (first < 0 || second >= 0) {
      throw new Error(
        `Expected oldText exactly once in ${path}, but found ${countOccurrences(current, edit.oldText)} occurrences.`,
      );
    }
    const after =
      current.slice(0, first) + edit.newText + current.slice(first + edit.oldText.length);
    return [path, current, after];
  });

  const proposal: SourceEditProposal = {
    changes,
    id: randomUUID(),
    summary: input.summary,
  };
  const ctx = loadContext();
  const state = ctx.ensure(SelfmodEditStateKey, () => ({ proposals: {} }));
  ctx.set(SelfmodEditStateKey, {
    proposals: { ...state.proposals, [proposal.id]: proposal },
  });
  return { proposalId: proposal.id };
}

function countOccurrences(content: string, search: string): number {
  let count = 0;
  let index = 0;
  while ((index = content.indexOf(search, index)) >= 0) {
    count += 1;
    index += search.length;
  }
  return count;
}

/** Applies a recorded proposal after its approval gate passes. */
export async function applyEdits(
  sandbox: SelfmodEditSandbox,
  proposalId: string,
): Promise<z.infer<typeof APPLY_EDITS_OUTPUT_SCHEMA>> {
  const proposal = requirePendingProposal(proposalId);

  const currentContents = await Promise.all(
    proposal.changes.map(([path]) => sandbox.readTextFile({ path })),
  );
  for (const [index, [path, before]] of proposal.changes.entries()) {
    if ((currentContents[index] ?? null) !== before) {
      throw new Error(
        `${path} changed after the edits were proposed. Inspect it and propose the edits again.`,
      );
    }
  }

  for (const [path, , after] of proposal.changes) {
    if (after === null) {
      await sandbox.removePath({ path });
    } else {
      await sandbox.writeTextFile({ content: after, path });
    }
  }

  const ctx = loadContext();
  const state = ctx.require(SelfmodEditStateKey);
  const remainingProposals = { ...state.proposals };
  delete remainingProposals[proposalId];
  ctx.set(SelfmodEditStateKey, { proposals: remainingProposals });

  return {
    changedFiles: proposal.changes.map(([path]) => path),
    proposalId,
  };
}

async function executeProposeEdits(
  input: unknown,
  options?: ToolExecuteOptions,
): Promise<SourceEditProposalReference> {
  return await proposeEdits(
    await requireSandboxSession(options?.abortSignal),
    input as z.infer<typeof PROPOSE_EDITS_INPUT_SCHEMA>,
  );
}

async function executeApplyEdits(
  input: unknown,
  options?: ToolExecuteOptions,
): Promise<z.infer<typeof APPLY_EDITS_OUTPUT_SCHEMA>> {
  const { proposalId } = input as SourceEditProposalReference;
  return await applyEdits(await requireSandboxSession(options?.abortSignal), proposalId);
}

export const PROPOSE_EDITS_TOOL_DEFINITION: ResolvedToolDefinition = {
  description:
    "Finalize source edits without writing files. Pass the returned proposalId to apply_edits.",
  execute: executeProposeEdits,
  inputSchema: PROPOSE_EDITS_INPUT_SCHEMA,
  logicalPath: "eve:framework/selfmod/propose-edits",
  name: PROPOSE_EDITS_TOOL_NAME,
  outputSchema: PROPOSAL_REFERENCE_SCHEMA,
  sourceId: "eve:selfmod-propose-edits-tool",
  sourceKind: "module",
};

export const APPLY_EDITS_TOOL_DEFINITION: ResolvedToolDefinition = {
  approval: requestApplyEditsApproval,
  description:
    "Request human approval for a proposalId returned by propose_edits, then apply its exact edits.",
  execute: executeApplyEdits,
  inputSchema: PROPOSAL_REFERENCE_SCHEMA,
  logicalPath: "eve:framework/selfmod/apply-edits",
  name: APPLY_EDITS_TOOL_NAME,
  outputSchema: APPLY_EDITS_OUTPUT_SCHEMA,
  sourceId: "eve:selfmod-apply-edits-tool",
  sourceKind: "module",
};

export const SELFMOD_EDIT_TOOL_DEFINITIONS: readonly ResolvedToolDefinition[] = [
  PROPOSE_EDITS_TOOL_DEFINITION,
  APPLY_EDITS_TOOL_DEFINITION,
];
