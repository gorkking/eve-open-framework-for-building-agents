import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { resolveInstrumentationLayout } from "#internal/instrumentation-layout.js";

let agentRoot: string;

beforeEach(() => {
  agentRoot = mkdtempSync(join(tmpdir(), "eve-instrumentation-layout-"));
});

function writeConfig(extension = ".ts"): string {
  const path = join(agentRoot, `instrumentation${extension}`);
  writeFileSync(path, "export default {};\n");
  return path;
}

function writeProvider(fileName: string): string {
  const directory = join(agentRoot, "instrumentation");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, fileName);
  writeFileSync(path, "export default {};\n");
  return path;
}

describe("resolveInstrumentationLayout with providers off", () => {
  it("returns nothing when the agent authored no instrumentation", () => {
    expect(resolveInstrumentationLayout({ agentRoot, providersEnabled: false })).toBeUndefined();
  });

  it("resolves the single config module", () => {
    const modulePath = writeConfig();

    expect(resolveInstrumentationLayout({ agentRoot, providersEnabled: false })).toEqual({
      kind: "config",
      modulePath,
    });
  });

  it.each([[".mts"], [".js"], [".mjs"]])("resolves a %s config module", (extension) => {
    const modulePath = writeConfig(extension);

    expect(resolveInstrumentationLayout({ agentRoot, providersEnabled: false })).toEqual({
      kind: "config",
      modulePath,
    });
  });

  it("rejects a providers directory, naming the flag", () => {
    writeProvider("otel.ts");

    expect(() => resolveInstrumentationLayout({ agentRoot, providersEnabled: false })).toThrow(
      /experimental\.instrumentationProviders/,
    );
  });
});

describe("resolveInstrumentationLayout with providers on", () => {
  it("returns nothing when the agent authored no instrumentation", () => {
    expect(resolveInstrumentationLayout({ agentRoot, providersEnabled: true })).toBeUndefined();
  });

  it("keys each file by the slot its name derives", () => {
    const otel = writeProvider("otel.ts");
    const local = writeProvider("local.mts");

    expect(resolveInstrumentationLayout({ agentRoot, providersEnabled: true })).toEqual({
      kind: "providers",
      modulePathsBySlot: { local, otel },
    });
  });

  it("orders slots independently of directory enumeration", () => {
    writeProvider("otel.ts");
    writeProvider("agent-runs.ts");
    writeProvider("local.ts");

    const layout = resolveInstrumentationLayout({ agentRoot, providersEnabled: true });

    expect(Object.keys(layout?.kind === "providers" ? layout.modulePathsBySlot : {})).toEqual([
      "agent-runs",
      "local",
      "otel",
    ]);
  });

  it("ignores files that are not instrumentation modules", () => {
    writeProvider("otel.ts");
    writeProvider("README.md");

    const layout = resolveInstrumentationLayout({ agentRoot, providersEnabled: true });

    expect(Object.keys(layout?.kind === "providers" ? layout.modulePathsBySlot : {})).toEqual([
      "otel",
    ]);
  });

  it("rejects two files claiming one slot", () => {
    writeProvider("otel.ts");
    writeProvider("otel.js");

    expect(() => resolveInstrumentationLayout({ agentRoot, providersEnabled: true })).toThrow(
      /Two files declare the "otel" instrumentation provider/,
    );
  });

  it("rejects a single config module, naming the flag", () => {
    writeConfig();

    expect(() => resolveInstrumentationLayout({ agentRoot, providersEnabled: true })).toThrow(
      /experimental\.instrumentationProviders/,
    );
  });

  it("prefers the config error when both layouts are present", () => {
    writeConfig();
    writeProvider("otel.ts");

    expect(() => resolveInstrumentationLayout({ agentRoot, providersEnabled: true })).toThrow(
      /Move it into the "instrumentation\/" directory/,
    );
  });
});
