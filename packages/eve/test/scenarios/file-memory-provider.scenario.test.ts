import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";

const runFile = promisify(execFile);
const scenarioApp = useScenarioApp();

const FILE_MEMORY_DESCRIPTOR: ScenarioAppDescriptor = {
  files: {
    "smoke.mjs": `import { fileMemory, inMemory } from "eve/memory/file";
import { vercelBlob } from "eve/memory/file/vercel";

const provider = fileMemory({ backend: inMemory() });
const blob = vercelBlob({ token: "unused" });

console.log(JSON.stringify({
  blob: typeof blob.read,
  provider: typeof provider.events?.["session.started"] === "function" &&
    typeof provider.events?.["compaction.completed"] === "function",
}));
`,
  },
  installDependencies: true,
  name: "file-memory-provider",
};

describe("packaged file-memory provider", () => {
  it("loads the provider and vendored Vercel Blob backend from public exports", async () => {
    const app = await scenarioApp(FILE_MEMORY_DESCRIPTOR);
    const { stdout } = await runFile(process.execPath, ["smoke.mjs"], { cwd: app.appRoot });

    expect(JSON.parse(stdout)).toEqual({ blob: "function", provider: true });
  });
});
