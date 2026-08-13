import { readFile, readdir } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { parseAst } from "rolldown/parseAst";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
const runtimeDependencies = new Set(Object.keys(packageJson.dependencies ?? {}));
const developmentDependencies = new Set(Object.keys(packageJson.devDependencies ?? {}));
const binRoot = join(packageRoot, "bin");
const requiredRuntimePrimitives = ["nf3", "rolldown"];
const requiredVendoredPrimitives = ["croner", "crossws", "h3", "srvx"];

function isRemovedFrameworkPackage(dependency) {
  const name = dependency.startsWith("@") ? dependency.split("/")[1] : dependency;
  return /^nitro(?:pack)?(?:$|-)/i.test(name ?? "");
}

function packageName(specifier) {
  if (specifier.startsWith("@")) {
    return specifier.split("/").slice(0, 2).join("/");
  }
  return specifier.split("/", 1)[0];
}

function isBarePackageImport(specifier) {
  return (
    !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !specifier.startsWith("#") &&
    !specifier.includes(":") &&
    !isBuiltin(specifier)
  );
}

function* exportTargets(value) {
  if (typeof value === "string") {
    yield value;
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      yield* exportTargets(entry);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) {
      yield* exportTargets(entry);
    }
  }
}

async function* walkJavaScriptFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkJavaScriptFiles(path);
    } else if (entry.isFile() && /\.(?:c|m)?js$/.test(entry.name)) {
      yield path;
    }
  }
}

const manifestViolations = [];
for (const dependency of requiredRuntimePrimitives) {
  if (!runtimeDependencies.has(dependency)) {
    manifestViolations.push(
      `package.json must declare "${dependency}" directly in dependencies; eve uses this primitive at build or runtime.`,
    );
  }
}

for (const dependency of requiredVendoredPrimitives) {
  if (!developmentDependencies.has(dependency)) {
    manifestViolations.push(
      `package.json must declare vendored primitive "${dependency}" in devDependencies.`,
    );
  }
  if (runtimeDependencies.has(dependency)) {
    manifestViolations.push(
      `package.json must not declare vendored primitive "${dependency}" in dependencies.`,
    );
  }
}

for (const section of [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]) {
  for (const dependency of Object.keys(packageJson[section] ?? {})) {
    if (isRemovedFrameworkPackage(dependency)) {
      manifestViolations.push(
        `package.json ${section} must not declare "${dependency}"; eve owns its build and routing stack directly.`,
      );
    }
  }
}

for (const target of exportTargets(packageJson.exports)) {
  if (target.startsWith("./src/")) {
    manifestViolations.push(
      `package.json exports target "${target}" is excluded from the published package; public exports must resolve through dist.`,
    );
  }
}

const importViolations = [];

for await (const path of walkJavaScriptFiles(binRoot)) {
  const source = await readFile(path, "utf8");
  const ast = parseAst(
    source,
    { astType: "ts", lang: "js", range: true, sourceType: "module" },
    relative(packageRoot, path),
  );

  for (const statement of ast.body ?? []) {
    if (statement.type !== "ImportDeclaration" || typeof statement.source.value !== "string") {
      continue;
    }
    const specifier = statement.source.value;
    if (!isBarePackageImport(specifier)) {
      continue;
    }
    const dependency = packageName(specifier);
    if (!runtimeDependencies.has(dependency)) {
      importViolations.push({ dependency, path: relative(packageRoot, path), specifier });
    }
  }
}

if (manifestViolations.length > 0 || importViolations.length > 0) {
  for (const violation of manifestViolations) {
    process.stderr.write(`${violation}\n`);
  }
  for (const violation of importViolations) {
    process.stderr.write(
      `${violation.path} imports "${violation.specifier}", but "${violation.dependency}" is not ` +
        "declared in package.json dependencies. eve's bin files ship unbundled, so every bare " +
        "import must be available in production installs.\n",
    );
  }
  process.exit(1);
}

process.stdout.write("[eve:check-bin-runtime-dependencies] ok\n");
