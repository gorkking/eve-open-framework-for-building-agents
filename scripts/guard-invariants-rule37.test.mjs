import assert from "node:assert/strict";
import test from "node:test";

import { checkRule37 } from "./guard-invariants-rule37.mjs";

const LIFECYCLE_CONTRACT = "packages/eve/src/harness/instrumentation-lifecycle.ts";

const fixtures = [
  {
    line: 4,
    name: "multiline static import",
    source: `import type {
  Telemetry,
} from
  "ai";`,
  },
  {
    line: 2,
    name: "multiline dynamic import type",
    source: `type Telemetry = typeof import(
  "ai"
);`,
  },
  {
    line: 2,
    name: "multiline dynamic import expression",
    source: `const sdk = await import(
  "ai"
);`,
  },
];

for (const fixture of fixtures) {
  test(`Rule 37 rejects ${fixture.name}`, () => {
    const violations = [];

    checkRule37(LIFECYCLE_CONTRACT, fixture.source, violations);

    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.line, fixture.line);
  });
}

test("Rule 37 ignores import-like text and other packages", () => {
  const violations = [];

  checkRule37(
    LIFECYCLE_CONTRACT,
    `const example = 'import("ai")';
// import type { Telemetry } from "ai";
import type { SDK } from "ai-sdk";`,
    violations,
  );

  assert.deepEqual(violations, []);
});
