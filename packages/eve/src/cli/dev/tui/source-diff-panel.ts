import type { SourceDiffPresentation } from "#shared/source-diff-presentation.js";
import { clipVisible, stripTerminalControls, wrapVisibleLine } from "#cli/ui/terminal-text.js";
import type { Theme } from "./theme.js";

export interface SourceDiffPanelState {
  readonly fileIndex: number;
  readonly presentation: SourceDiffPresentation;
  readonly scroll: number;
}

interface DiffLine {
  readonly kind: "added" | "context" | "gap" | "removed";
  readonly text: string;
}

const CONTEXT_LINES = 3;

export function renderSourceDiffPanel(
  state: SourceDiffPanelState,
  theme: Theme,
  width: number,
  height: number,
): string[] {
  const file = state.presentation.files[state.fileIndex];
  if (file === undefined) return [];
  const c = theme.colors;
  const body = createDiffLines(file.before, file.after).flatMap((line) =>
    renderDiffLine(line, theme, width),
  );
  const bodyHeight = Math.max(1, height - 5);
  const maxScroll = Math.max(0, body.length - bodyHeight);
  const scroll = Math.min(Math.max(0, state.scroll), maxScroll);
  const visible = body.slice(scroll, scroll + bodyHeight);
  const status = file.status === "create" ? "A" : file.status === "delete" ? "D" : "M";
  const position = `${state.fileIndex + 1}/${state.presentation.files.length}`;
  const byteSummary = formatBytes(state.presentation.changedBytes);
  const rows = [
    c.dim(theme.glyph.hrule.repeat(Math.max(1, width))),
    `  ${c.bold("Review proposed edits")}  ${c.dim(`${position} · ${byteSummary}`)}`,
    `  ${statusColor(status, theme)(status)} ${c.bold(file.path)}`,
    "",
    ...visible,
    "",
    `  ${c.dim("Space page · ←/→ files · ↑/↓ scroll · Home/End · y apply · n reject")}`,
  ];
  return rows.map((row) => clipVisible(row, width));
}

export function moveSourceDiffPanel(
  state: SourceDiffPanelState,
  action: "down" | "end" | "home" | "next-file" | "page-down" | "previous-file" | "up",
  viewportHeight = 1,
  width = 80,
): SourceDiffPanelState {
  const file = state.presentation.files[state.fileIndex];
  const lineCount =
    file === undefined
      ? 0
      : createDiffLines(file.before, file.after).flatMap((line) => wrapDiffLine(line, width))
          .length;
  const maxScroll = Math.max(0, lineCount - viewportHeight);
  switch (action) {
    case "down":
      return { ...state, scroll: Math.min(maxScroll, state.scroll + 1) };
    case "up":
      return { ...state, scroll: Math.max(0, state.scroll - 1) };
    case "page-down":
      if (state.scroll < maxScroll) {
        return { ...state, scroll: Math.min(maxScroll, state.scroll + viewportHeight) };
      }
      return state.fileIndex < state.presentation.files.length - 1
        ? { ...state, fileIndex: state.fileIndex + 1, scroll: 0 }
        : { ...state, scroll: maxScroll };
    case "home":
      return { ...state, scroll: 0 };
    case "end":
      return { ...state, scroll: maxScroll };
    case "next-file":
      return {
        ...state,
        fileIndex: Math.min(state.presentation.files.length - 1, state.fileIndex + 1),
        scroll: 0,
      };
    case "previous-file":
      return { ...state, fileIndex: Math.max(0, state.fileIndex - 1), scroll: 0 };
  }
}

function createDiffLines(before: string | null, after: string | null): DiffLine[] {
  const previous = splitLines(before ?? "");
  const next = splitLines(after ?? "");
  if (
    before !== null &&
    after !== null &&
    before !== after &&
    previous.length === next.length &&
    previous.every((line, index) => line === next[index])
  ) {
    return [
      { kind: "removed", text: describeLineEndings(before) },
      { kind: "added", text: describeLineEndings(after) },
    ];
  }
  let prefix = 0;
  while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < previous.length - prefix &&
    suffix < next.length - prefix &&
    previous[previous.length - suffix - 1] === next[next.length - suffix - 1]
  ) {
    suffix += 1;
  }

  const lines: DiffLine[] = [];
  appendContextWindow(lines, previous.slice(0, prefix), "leading");
  for (const text of previous.slice(prefix, previous.length - suffix)) {
    lines.push({ kind: "removed", text });
  }
  for (const text of next.slice(prefix, next.length - suffix)) {
    lines.push({ kind: "added", text });
  }
  appendContextWindow(lines, previous.slice(previous.length - suffix), "trailing");
  if (lines.length === 0) {
    if (before === after) return [{ kind: "context", text: "(no textual difference)" }];
    if (before === null) return [{ kind: "added", text: "(empty file)" }];
    if (after === null) return [{ kind: "removed", text: "(empty file)" }];
    return [
      { kind: "removed", text: describeLineEndings(before) },
      { kind: "added", text: describeLineEndings(after) },
    ];
  }
  return lines;
}

function appendContextWindow(
  output: DiffLine[],
  context: readonly string[],
  position: "leading" | "trailing",
): void {
  if (context.length <= CONTEXT_LINES * 2) {
    output.push(...context.map((text): DiffLine => ({ kind: "context", text })));
    return;
  }
  if (position === "leading") {
    output.push({ kind: "gap", text: `… ${context.length - CONTEXT_LINES} unchanged lines …` });
    output.push(
      ...context.slice(-CONTEXT_LINES).map((text): DiffLine => ({ kind: "context", text })),
    );
    return;
  }
  output.push(
    ...context.slice(0, CONTEXT_LINES).map((text): DiffLine => ({ kind: "context", text })),
  );
  output.push({ kind: "gap", text: `… ${context.length - CONTEXT_LINES} unchanged lines …` });
}

function splitLines(content: string): string[] {
  const lines = content.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function renderDiffLine(line: DiffLine, theme: Theme, width: number): string[] {
  const c = theme.colors;
  return wrapDiffLine(line, width).map((text) => {
    switch (line.kind) {
      case "added":
        return c.green(text);
      case "removed":
        return c.red(text);
      case "gap":
        return c.dim(text);
      case "context":
        return text;
    }
  });
}

function wrapDiffLine(line: DiffLine, width: number): string[] {
  const prefix = line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : "  ";
  const text = stripTerminalControls(line.text);
  const segments = wrapVisibleLine(text, Math.max(1, width - prefix.length));
  return segments.map((segment, index) => `${index === 0 ? prefix : "  "}${segment}`);
}

function describeLineEndings(content: string): string {
  const crlf = (content.match(/\r\n/gu) ?? []).length;
  const bareLf = (content.match(/(?<!\r)\n/gu) ?? []).length;
  const ending = crlf > 0 && bareLf > 0 ? "mixed" : crlf > 0 ? "CRLF" : "LF";
  return `[line endings: ${ending}; trailing newline: ${/\r?\n$/u.test(content) ? "yes" : "no"}]`;
}

function statusColor(status: string, theme: Theme): (text: string) => string {
  return status === "D"
    ? theme.colors.red
    : status === "A"
      ? theme.colors.green
      : theme.colors.yellow;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
