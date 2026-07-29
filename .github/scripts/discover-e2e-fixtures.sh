#!/usr/bin/env bash
# Discover e2e fixture directories for the CI matrix.
#
# A fixture qualifies when it has an `evals/` directory under one of the
# fixture roots. Emits a JSON array of `{ name, dir }` objects (sorted by dir)
# to the `matrix` GitHub Actions output for the workflow's `fixture` axis.
set -euo pipefail

roots=("e2e/fixtures" "apps/fixtures")

entries=()
fixture_dirs=()
while IFS= read -r evals_dir; do
  dir="${evals_dir%/evals}"
  name="$(basename "$dir")"
  fixture_dirs+=("$dir")
  entries+=("{\"name\":\"${name}\",\"dir\":\"${dir}\"}")
done < <(
  for root in "${roots[@]}"; do
    [ -d "$root" ] || continue
    find "$root" -mindepth 2 -maxdepth 2 -type d -name evals
  done | sort
)

if [ "${#entries[@]}" -eq 0 ]; then
  echo "No e2e fixtures with an evals/ directory were found." >&2
  exit 1
fi

node --input-type=module - "${fixture_dirs[@]}" <<'NODE'
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const failures = [];
for (const fixtureDir of process.argv.slice(2)) {
  const packagePath = join(fixtureDir, "package.json");
  const agentPath = join(fixtureDir, "agent", "agent.ts");

  if (!existsSync(packagePath)) {
    failures.push(`${fixtureDir}: missing package.json`);
    continue;
  }
  if (!existsSync(agentPath)) {
    failures.push(`${fixtureDir}: missing agent/agent.ts`);
    continue;
  }

  const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
  const dependencies = manifest.dependencies ?? {};
  if (dependencies["@eve-e2e/config"] !== "workspace:*") {
    failures.push(`${fixtureDir}: dependencies must include @eve-e2e/config as workspace:*`);
  }
  if (dependencies["@workflow/world-postgres"] !== "catalog:") {
    failures.push(
      `${fixtureDir}: dependencies must include @workflow/world-postgres from the catalog`,
    );
  }

  const agentSource = readFileSync(agentPath, "utf8");
  if (
    !agentSource.includes("@eve-e2e/config") ||
    !agentSource.includes("...e2eAgentConfig()")
  ) {
    failures.push(`${fixtureDir}: root agent must spread ...e2eAgentConfig()`);
  }
}

if (failures.length > 0) {
  console.error("Invalid e2e fixture contract:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}
NODE

matrix="[$(
  IFS=,
  echo "${entries[*]}"
)]"

echo "Discovered fixtures: ${matrix}"
echo "matrix=${matrix}" >>"${GITHUB_OUTPUT:-/dev/stdout}"
