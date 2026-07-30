import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { consumeApprovalPresentation } from "#harness/approval-presentation.js";
import {
  APPLY_EDITS_TOOL_DEFINITION,
  applyEdits,
  proposeEdits,
} from "#runtime/framework-tools/selfmod-edits.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

function createSandbox(initial: Readonly<Record<string, string>>): {
  readonly files: Map<string, string>;
  readonly removePath: ReturnType<typeof vi.fn>;
  readonly sandbox: Pick<SandboxSession, "readTextFile" | "removePath" | "writeTextFile">;
  readonly writeTextFile: ReturnType<typeof vi.fn>;
} {
  const files = new Map(Object.entries(initial));
  const writeTextFile = vi.fn(async ({ content, path }: { content: string; path: string }) => {
    files.set(path, content);
  });
  const removePath = vi.fn(async ({ path }: { path: string }) => {
    files.delete(path);
  });
  const sandbox = {
    readTextFile: vi.fn(async ({ path }: { path: string }) => files.get(path) ?? null),
    removePath,
    writeTextFile,
  } satisfies Pick<SandboxSession, "readTextFile" | "removePath" | "writeTextFile">;
  return { files, removePath, sandbox, writeTextFile };
}

async function withContext<T>(fn: () => Promise<T>): Promise<T> {
  return await contextStorage.run(new ContextContainer(), fn);
}

describe("selfmod edit tools", () => {
  it("records a reviewable proposal without writing, then applies it after approval", async () => {
    const { files, removePath, sandbox, writeTextFile } = createSandbox({
      "/workspace/agent.ts": "model: 'old'\n",
      "/workspace/obsolete.md": "remove me\n",
    });

    await withContext(async () => {
      const proposal = await proposeEdits(sandbox, {
        edits: [
          {
            filePath: "/workspace/agent.ts",
            kind: "replace",
            newText: "model: 'new'",
            oldText: "model: 'old'",
          },
          { content: "hello\n", filePath: "/workspace/new.md", kind: "create" },
          { filePath: "/workspace/obsolete.md", kind: "delete" },
        ],
        summary: "Update the model and supporting files.",
      });

      expect(proposal).toEqual({ proposalId: expect.any(String) });
      expect(writeTextFile).not.toHaveBeenCalled();
      expect(removePath).not.toHaveBeenCalled();
      expect(files.get("/workspace/agent.ts")).toBe("model: 'old'\n");

      await applyEdits(sandbox, proposal.proposalId);

      expect(files.get("/workspace/agent.ts")).toBe("model: 'new'\n");
      expect(files.get("/workspace/new.md")).toBe("hello\n");
      expect(files.has("/workspace/obsolete.md")).toBe(false);
    });
  });

  it("refuses an unknown proposal and a file changed while approval was pending", async () => {
    const { files, sandbox } = createSandbox({ "/workspace/a.ts": "old\n" });

    await withContext(async () => {
      const proposal = await proposeEdits(sandbox, {
        edits: [{ filePath: "/workspace/a.ts", kind: "replace", newText: "new", oldText: "old" }],
        summary: "Change a.ts.",
      });

      await expect(applyEdits(sandbox, "00000000-0000-4000-8000-000000000000")).rejects.toThrow(
        "Unknown or expired",
      );

      files.set("/workspace/a.ts", "external change\n");
      await expect(applyEdits(sandbox, proposal.proposalId)).rejects.toThrow(
        "changed after the edits were proposed",
      );
    });
  });

  it("reads changed files concurrently", async () => {
    let releaseReads!: () => void;
    const readsReleased = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    const readTextFile = vi.fn(async () => {
      await readsReleased;
      return "old\n";
    });
    const sandbox = {
      readTextFile,
      removePath: vi.fn(),
      writeTextFile: vi.fn(),
    } satisfies Pick<SandboxSession, "readTextFile" | "removePath" | "writeTextFile">;

    const pending = withContext(
      async () =>
        await proposeEdits(sandbox, {
          edits: [
            { filePath: "/workspace/a.ts", kind: "delete" },
            { filePath: "/workspace/b.ts", kind: "delete" },
          ],
          summary: "Delete two files.",
        }),
    );
    await vi.waitFor(() => expect(readTextFile).toHaveBeenCalledTimes(2));
    releaseReads();

    await expect(pending).resolves.toEqual({ proposalId: expect.any(String) });
  });

  it("returns a compact reference even for a large proposal", async () => {
    const { sandbox } = createSandbox({});

    await withContext(async () => {
      const proposal = await proposeEdits(sandbox, {
        edits: [
          { content: "x".repeat(1_000_000), filePath: "/workspace/large.txt", kind: "create" },
        ],
        summary: "Create a large file.",
      });

      expect(JSON.stringify(proposal).length).toBeLessThan(64);
    });
  });

  it("requires approval with the complete source diff", async () => {
    const { sandbox } = createSandbox({ "/workspace/a.ts": "old\n" });

    await withContext(async () => {
      const proposal = await proposeEdits(sandbox, {
        edits: [{ filePath: "/workspace/a.ts", kind: "replace", newText: "new", oldText: "old" }],
        summary: "Change a.ts.",
      });
      const approval = await APPLY_EDITS_TOOL_DEFINITION.approval?.({
        callId: "call-1",
        session: { id: "session-1" },
        toolInput: proposal,
      } as never);

      expect(approval).toBe("user-approval");
      expect(consumeApprovalPresentation("session-1", "call-1")?.sourceDiff).toEqual({
        changedBytes: 8,
        files: [
          {
            after: "new\n",
            before: "old\n",
            path: "/workspace/a.ts",
            status: "modify",
          },
        ],
        kind: "source-diff",
      });
    });
  });
});
