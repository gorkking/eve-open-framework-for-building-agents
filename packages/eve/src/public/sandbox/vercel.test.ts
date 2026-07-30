import { describe, expect, it } from "vitest";

import { VercelSandbox } from "#public/sandbox/vercel.js";
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
});
