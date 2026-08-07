import { describe, expect, it } from "vitest";

import { parseSetupAnswer } from "./setup-answers.js";
import { headlessSetupContinuation } from "./setup-headless.js";

describe("setup answers", () => {
  it("accumulates strings and JSON values", () => {
    const first = parseSetupAnswer("mode=portable");
    const answers = parseSetupAnswer('events=["issues","pull_request"]', first);

    expect(answers).toEqual({ mode: "portable", events: ["issues", "pull_request"] });
  });

  it("builds a safe resume command with prior answers", () => {
    expect(
      headlessSetupContinuation({
        item: "channel/github",
        installed: true,
        answers: { "github-events": ["issues"] },
      }),
    ).toBe(
      "eve add channel/github --headless --json --skip-install --answer github-events='[\"issues\"]'",
    );
  });
});
