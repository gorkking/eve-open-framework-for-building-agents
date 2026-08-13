let rolldownPromise;

export async function loadRolldown() {
  rolldownPromise ??= import("rolldown");

  return await rolldownPromise;
}

export async function buildWithRolldown(options) {
  assertCustomRolldownConditionNames(options);
  const { build } = await loadRolldown();
  return await build(options);
}

const ROLLDOWN_STANDARD_CONDITION_NAMES = new Set([
  "browser",
  "default",
  "import",
  "node",
  "require",
]);

function assertCustomRolldownConditionNames(options) {
  for (const conditionName of options.resolve?.conditionNames ?? []) {
    if (ROLLDOWN_STANDARD_CONDITION_NAMES.has(conditionName)) {
      throw new Error(
        `Rolldown resolves the standard condition ${JSON.stringify(conditionName)} per import edge; conditionNames may contain only eve-specific additions.`,
      );
    }
  }
}
