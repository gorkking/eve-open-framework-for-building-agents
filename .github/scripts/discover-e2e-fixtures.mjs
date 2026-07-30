#!/usr/bin/env node

import { appendFile, readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

const FIXTURE_ROOTS = ["e2e/fixtures", "apps/fixtures"];
const MANIFEST_PATH = "e2e/suites.json";
const EVAL_SOURCE_FILE_PATTERN = /\.[cm]?[jt]sx?$/u;
const JUDGE_USAGE_PATTERN = /\bt\s*\.\s*judge\b/u;
const MODEL_ALIAS_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function fail(message) {
  throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function discoverFixtures() {
  const fixtureDirs = [];

  for (const root of FIXTURE_ROOTS) {
    if (!(await isDirectory(root))) {
      continue;
    }

    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const fixtureDir = join(root, entry.name);
      if (await isDirectory(join(fixtureDir, "evals"))) {
        fixtureDirs.push(fixtureDir);
      }
    }
  }

  return fixtureDirs.sort();
}

async function walkEvalSourceFiles(directory) {
  const files = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkEvalSourceFiles(path)));
    } else if (entry.isFile() && EVAL_SOURCE_FILE_PATTERN.test(entry.name)) {
      files.push(path);
    }
  }

  return files;
}

async function assertNoJudgeUsage(fixtureDir) {
  for (const path of await walkEvalSourceFiles(join(fixtureDir, "evals"))) {
    const source = await readFile(path, "utf8");
    if (JUDGE_USAGE_PATTERN.test(stripCommentsAndStringLiterals(source))) {
      fail(`World-suite fixture ${fixtureDir} uses t.judge in ${path}.`);
    }
  }
}

function stripCommentsAndStringLiterals(source) {
  let code = "";
  let state = "code";
  let templateExpressionDepth = 0;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (state === "code") {
      if (templateExpressionDepth > 0 && character === "{") {
        code += character;
        templateExpressionDepth += 1;
      } else if (templateExpressionDepth > 0 && character === "}") {
        templateExpressionDepth -= 1;
        code += templateExpressionDepth === 0 ? " " : character;
        if (templateExpressionDepth === 0) {
          state = "template";
        }
      } else if (character === "/" && next === "/") {
        code += "  ";
        state = "line-comment";
        index += 1;
      } else if (character === "/" && next === "*") {
        code += "  ";
        state = "block-comment";
        index += 1;
      } else if (character === "`") {
        code += " ";
        state = "template";
      } else if (character === "'" || character === '"') {
        code += " ";
        state = character;
      } else {
        code += character;
      }
      continue;
    }

    if (state === "template") {
      if (character === "\\") {
        code += " ";
        if (next !== undefined) {
          code += next === "\n" ? "\n" : " ";
          index += 1;
        }
      } else if (character === "`") {
        code += " ";
        state = "code";
      } else if (character === "$" && next === "{") {
        code += "  ";
        state = "code";
        templateExpressionDepth = 1;
        index += 1;
      } else {
        code += character === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (state === "line-comment") {
      if (character === "\n") {
        code += "\n";
        state = "code";
      } else {
        code += " ";
      }
      continue;
    }

    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        code += "  ";
        state = "code";
        index += 1;
      } else {
        code += character === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (character === "\\") {
      code += " ";
      if (next !== undefined) {
        code += next === "\n" ? "\n" : " ";
        index += 1;
      }
    } else if (character === state) {
      code += " ";
      state = "code";
    } else {
      code += character === "\n" ? "\n" : " ";
    }
  }

  return code;
}

function validateModelAliases(value) {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    fail(`${MANIFEST_PATH} must define a non-empty modelAliases object.`);
  }

  for (const [alias, modelId] of Object.entries(value)) {
    if (
      !MODEL_ALIAS_PATTERN.test(alias) ||
      typeof modelId !== "string" ||
      modelId.trim().length === 0
    ) {
      fail(`Invalid model alias ${JSON.stringify(alias)} in ${MANIFEST_PATH}.`);
    }
  }

  return value;
}

function validateFixtureAssignment(fixtureDir, value, modelAliases) {
  if (!isRecord(value)) {
    fail(`Fixture assignment for ${fixtureDir} must be an object.`);
  }

  if (value.suite === "worlds") {
    const keys = Object.keys(value);
    if (keys.length !== 1 || keys[0] !== "suite") {
      fail(`World-suite fixture ${fixtureDir} must use exactly {"suite":"worlds"}.`);
    }
    return value;
  }

  if (value.suite === "models") {
    const keys = Object.keys(value).sort();
    if (keys.length !== 2 || keys[0] !== "models" || keys[1] !== "suite") {
      fail(`Model-suite fixture ${fixtureDir} must contain only suite and models.`);
    }
    if (!Array.isArray(value.models) || value.models.length === 0) {
      fail(`Model-suite fixture ${fixtureDir} must select at least one model alias.`);
    }

    const uniqueModels = new Set(value.models);
    if (uniqueModels.size !== value.models.length) {
      fail(`Model-suite fixture ${fixtureDir} contains duplicate model aliases.`);
    }
    for (const alias of value.models) {
      if (typeof alias !== "string" || !Object.hasOwn(modelAliases, alias)) {
        fail(`Model-suite fixture ${fixtureDir} references invalid model alias ${String(alias)}.`);
      }
    }
    return value;
  }

  fail(`Fixture ${fixtureDir} has invalid suite ${JSON.stringify(value.suite)}.`);
}

async function emitOutput(name, value) {
  const line = `${name}=${JSON.stringify(value)}\n`;
  const outputPath = process.env.GITHUB_OUTPUT;

  if (outputPath === undefined || outputPath.length === 0) {
    process.stdout.write(line);
  } else {
    await appendFile(outputPath, line);
  }
}

async function main() {
  const discoveredDirs = await discoverFixtures();
  if (discoveredDirs.length === 0) {
    fail("No e2e fixtures with an evals/ directory were found.");
  }

  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  if (!isRecord(manifest)) {
    fail(`${MANIFEST_PATH} must contain an object.`);
  }
  const manifestKeys = Object.keys(manifest).sort();
  if (
    manifestKeys.length !== 2 ||
    manifestKeys[0] !== "fixtures" ||
    manifestKeys[1] !== "modelAliases"
  ) {
    fail(`${MANIFEST_PATH} must contain exactly modelAliases and fixtures.`);
  }

  const modelAliases = validateModelAliases(manifest.modelAliases);
  if (!isRecord(manifest.fixtures)) {
    fail(`${MANIFEST_PATH} must define a fixtures object keyed by fixture path.`);
  }

  const discoveredSet = new Set(discoveredDirs);
  const configuredDirs = Object.keys(manifest.fixtures).sort();
  const missingAssignments = discoveredDirs.filter((dir) => !(dir in manifest.fixtures));
  const staleAssignments = configuredDirs.filter((dir) => !discoveredSet.has(dir));

  if (missingAssignments.length > 0) {
    fail(`Fixtures missing from ${MANIFEST_PATH}: ${missingAssignments.join(", ")}`);
  }
  if (staleAssignments.length > 0) {
    fail(`Stale fixture assignments in ${MANIFEST_PATH}: ${staleAssignments.join(", ")}`);
  }

  const names = new Map();
  for (const dir of discoveredDirs) {
    const name = basename(dir);
    const previousDir = names.get(name);
    if (previousDir !== undefined) {
      fail(`Duplicate fixture name ${name}: ${previousDir} and ${dir}`);
    }
    names.set(name, dir);
  }

  const modelInclude = [];
  const worldInclude = [];

  for (const fixtureDir of discoveredDirs) {
    const fixtureName = basename(fixtureDir);
    const assignment = validateFixtureAssignment(
      fixtureDir,
      manifest.fixtures[fixtureDir],
      modelAliases,
    );

    if (assignment.suite === "worlds") {
      await assertNoJudgeUsage(fixtureDir);
      worldInclude.push({
        fixture_dir: fixtureDir,
        fixture_name: fixtureName,
      });
      continue;
    }

    for (const modelName of assignment.models) {
      modelInclude.push({
        fixture_dir: fixtureDir,
        fixture_name: fixtureName,
        model_id: modelAliases[modelName],
        model_name: modelName,
      });
    }
  }

  if (modelInclude.length === 0 || worldInclude.length === 0) {
    fail("Both the models and worlds suites must contain at least one fixture.");
  }

  const modelMatrix = { include: modelInclude };
  const worldMatrix = { include: worldInclude };
  console.log(
    `Discovered ${modelInclude.length} model leg(s) and ${worldInclude.length} world fixture(s).`,
  );
  await emitOutput("model_matrix", modelMatrix);
  await emitOutput("world_matrix", worldMatrix);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
