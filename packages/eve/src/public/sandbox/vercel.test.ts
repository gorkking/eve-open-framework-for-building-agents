import { describe, expect, expectTypeOf, it } from "vitest";

import {
  Drive,
  VercelSandbox,
  type VercelSandboxCreateOptions,
  type VercelSandboxSessionOptions,
  type VercelSandboxTemplateOptions,
} from "#public/sandbox/vercel.js";
import { getSandboxTemplateInternal } from "#shared/sandbox-template.js";

describe("VercelSandbox.template", () => {
  it("includes provider preparation options in the private template identity", () => {
    const first = getSandboxTemplateInternal(
      VercelSandbox.template({
        env: { A: "one", B: "two" },
        source: { revision: "main", type: "git", url: "https://example.com/repo.git" },
      }),
    );
    const reordered = getSandboxTemplateInternal(
      VercelSandbox.template({
        env: { B: "two", A: "one" },
        source: { url: "https://example.com/repo.git", type: "git", revision: "main" },
      }),
    );
    const changed = getSandboxTemplateInternal(
      VercelSandbox.template({
        env: { A: "changed", B: "two" },
        source: { revision: "main", type: "git", url: "https://example.com/repo.git" },
      }),
    );

    expect(reordered.implementationId).toBe(first.implementationId);
    expect(changed.implementationId).not.toBe(first.implementationId);
  });

  it("accepts serializable credential scope without persisting runtime credentials", () => {
    const options = {
      projectId: "prj_123",
      teamId: "team_123",
    } satisfies VercelSandboxCreateOptions;

    expect(() => VercelSandbox.template(options)).not.toThrow();
    expectTypeOf<VercelSandboxCreateOptions>().not.toHaveProperty("fetch");
    expectTypeOf<VercelSandboxCreateOptions>().not.toHaveProperty("token");
  });

  it("accepts drive mounts only when creating the live sandbox", () => {
    const template = VercelSandbox.template();
    const options = {
      mounts: {
        "/workspace": { drive: "repo-acme", mode: "read-write" },
      },
    } satisfies VercelSandboxSessionOptions;

    expectTypeOf(Drive.getOrCreate).toBeFunction();
    expectTypeOf(template.create)
      .parameter(0)
      .toEqualTypeOf<VercelSandboxSessionOptions | undefined>();
    expect(options.mounts["/workspace"]?.drive).toBe("repo-acme");
    expectTypeOf<VercelSandboxTemplateOptions>().not.toHaveProperty("mounts");
  });
});
