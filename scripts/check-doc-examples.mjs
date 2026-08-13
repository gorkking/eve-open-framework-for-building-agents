#!/usr/bin/env node
/**
 * CI lint that keeps documentation snippets in sync with `/examples` source.
 *
 * A pattern doc that claims to show real example code rots silently when the
 * example changes. Any fenced code block under /docs whose `title` is an
 * `examples/...` path must match that file's exact contents, so a drifted
 * snippet fails the build instead of shipping stale documentation.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const docsDir = `${repoRoot}/docs`;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".md") || entry.endsWith(".mdx")) out.push(full);
  }
  return out;
}

const fenceRe = /```[^\n]*\btitle="(examples\/[^"]+)"[^\n]*\n([\s\S]*?)```/g;

const failures = [];
let snippetCount = 0;

for (const abs of walk(docsDir)) {
  const rel = relative(repoRoot, abs);
  const source = readFileSync(abs, "utf8");
  let block;
  while ((block = fenceRe.exec(source)) !== null) {
    snippetCount += 1;
    const [, examplePath, snippet] = block;
    const exampleAbs = `${repoRoot}/${examplePath}`;
    if (!existsSync(exampleAbs)) {
      failures.push(`${rel}: titled snippet points at missing file ${examplePath}`);
      continue;
    }
    if (readFileSync(exampleAbs, "utf8").trim() !== snippet.trim()) {
      failures.push(`${rel}: snippet is out of sync with ${examplePath}`);
    }
  }
}

if (failures.length > 0) {
  console.error("[docs:examples] failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`[docs:examples] ok — ${snippetCount} example-titled snippets match their source.`);
