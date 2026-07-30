import { describe, expect, it } from "vitest";

import { moveSourceDiffPanel, renderSourceDiffPanel } from "./source-diff-panel.js";
import { createTheme } from "./theme.js";

const presentation = {
  changedBytes: 30,
  files: [
    {
      after: "one\nchanged\nthree\n",
      before: "one\ntwo\nthree\n",
      path: "instructions.md",
      status: "modify" as const,
    },
    {
      after: "new\n",
      before: null,
      path: "skills/new.md",
      status: "create" as const,
    },
  ],
  kind: "source-diff" as const,
};

describe("source diff panel", () => {
  it("renders one selected file with added and removed lines", () => {
    const rows = renderSourceDiffPanel(
      { fileIndex: 0, presentation, scroll: 0 },
      createTheme({ color: false, unicode: true }),
      80,
      14,
    );

    expect(rows.join("\n")).toContain("1/2");
    expect(rows.join("\n")).toContain("instructions.md");
    expect(rows.join("\n")).toContain("- two");
    expect(rows.join("\n")).toContain("+ changed");
  });

  it("surfaces changes that only affect line endings", () => {
    const rows = renderSourceDiffPanel(
      {
        fileIndex: 0,
        presentation: {
          changedBytes: 8,
          files: [{ after: "a\r\n", before: "a\n", path: "a.md", status: "modify" }],
          kind: "source-diff",
        },
        scroll: 0,
      },
      createTheme({ color: false, unicode: true }),
      80,
      14,
    );

    expect(rows.join("\n")).toContain("line endings: LF");
    expect(rows.join("\n")).toContain("line endings: CRLF");
  });

  it("pages down by one viewport", () => {
    const longPresentation = {
      changedBytes: 100,
      files: [
        {
          after: Array.from({ length: 10 }, (_, index) => `line ${index}`).join("\n"),
          before: "",
          path: "long.md",
          status: "modify" as const,
        },
      ],
      kind: "source-diff" as const,
    };
    const state = moveSourceDiffPanel(
      { fileIndex: 0, presentation: longPresentation, scroll: 0 },
      "page-down",
      3,
    );

    expect(state.scroll).toBe(3);
  });

  it("advances to the next file when paging past the current file", () => {
    const state = moveSourceDiffPanel({ fileIndex: 0, presentation, scroll: 12 }, "page-down", 4);

    expect(state).toMatchObject({ fileIndex: 1, scroll: 0 });
  });

  it("moves between files and resets scrolling", () => {
    const state = moveSourceDiffPanel({ fileIndex: 0, presentation, scroll: 12 }, "next-file");

    expect(state).toMatchObject({ fileIndex: 1, scroll: 0 });
  });
});
