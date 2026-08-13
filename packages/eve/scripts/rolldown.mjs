let rolldownPromise;

export async function loadRolldown() {
  rolldownPromise ??= import("rolldown");

  return await rolldownPromise;
}

export async function buildWithRolldown(options) {
  const { build } = await loadRolldown();
  return await build(options);
}
