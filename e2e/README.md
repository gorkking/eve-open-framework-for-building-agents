# e2e

End-to-end coverage is fixture-owned `eve eval` runs. The suite only runs
fixture eval files from the fixture directory.

CI separates the dimension under test instead of crossing every fixture,
model, and Workflow world:

- The **model suite** runs provider-sensitive fixtures against the local world.
  Its five fixtures expand to eight live-model legs.
- The **world suite** runs the other 15 fixtures with deterministic mock models
  against the Local, Vercel, and Postgres worlds, for 45 legs.

This produces 53 focused legs while retaining every fixture. There is no
nightly, manual, or other full cross-product matrix.

## Local

Run a model-suite fixture from its directory with one of its assigned models:

```sh
cd e2e/fixtures/agent-tools
EVE_E2E_MODEL="openai/gpt-5.6-sol" pnpm exec eve eval --strict
```

Model-suite runs require the credential for the selected provider. They use the
local Workflow world so failures exercise model and provider behavior without
also varying deployment infrastructure.

Run a world-suite fixture locally with deterministic authored models:

```sh
cd e2e/fixtures/agent-basic-runtime
EVE_MOCK_AUTHORED_MODELS=1 \
  AI_GATEWAY_API_KEY="invalid-e2e-world-suite-key" \
  pnpm exec eve eval --strict
```

`EVE_MOCK_AUTHORED_MODELS=1` replaces authored provider models with eve's
deterministic mock adapter. Models already authored as `eve-mock/*` remain
intact so fixtures can supply their own deterministic programs. The invalid
Gateway credential is a canary: a regression that escapes the adapter fails
instead of using a live provider. World fixtures cannot use `t.judge`;
discovery rejects that assignment, so their assertions never invoke a live
model judge.

Each fixture package also exposes its eval command as:

```sh
pnpm --filter agent-basic-runtime test:e2e
```

The root convenience command runs every fixture package with a `test:e2e`
script:

```sh
pnpm test:e2e
```

Use the explicit environment from the examples above when reproducing a
particular CI suite.

## Suite ownership

[`suites.json`](./suites.json) assigns every discovered fixture path to exactly
one suite. Its internal CI interface is:

```json
{
  "modelAliases": {
    "openai-sol": "openai/gpt-5.6-sol",
    "anthropic-opus": "anthropic/claude-opus-5"
  },
  "fixtures": {
    "e2e/fixtures/agent-tools": {
      "suite": "models",
      "models": ["openai-sol", "anthropic-opus"]
    },
    "e2e/fixtures/agent-basic-runtime": {
      "suite": "worlds"
    }
  }
}
```

Model aliases are stable CI identifiers:

- `openai-sol` selects `openai/gpt-5.6-sol`.
- `anthropic-opus` selects `anthropic/claude-opus-5`.

The provider assignments are intentionally narrow and meaningful:

- `agent-compaction-regressions`: `openai-sol`, `anthropic-opus`
- `agent-prompt-cache`: `anthropic-opus`
- `agent-tools`: `openai-sol`, `anthropic-opus`
- `agent-tools-hitl`: `openai-sol`, `anthropic-opus`
- `agent-tools-hitl-openai`: `openai-sol`

Those assignments produce the eight Local model legs. Every other fixture is
in the world suite, including `agent-model` and the Vercel redeploy coverage in
`agent-tools-sandbox`.

Fixture names remain derived from directory names. Discovery fails when a
fixture is missing from the manifest, a manifest path is stale, two paths
derive the same name, a model alias is unknown, or a world fixture contains a
`t.judge` call.

Run discovery from the repository root to validate the manifest and print the
`model_matrix` and `world_matrix` GitHub Actions outputs:

```sh
.github/scripts/discover-e2e-fixtures.sh
```

When adding e2e coverage:

- Put the eval in the fixture app's `evals/` directory.
- Add its path to `suites.json` as either a model fixture with explicit model
  aliases or a world fixture.
- Choose the model suite only when provider behavior, prompt handling, or model
  latency is part of the contract; otherwise choose the world suite.
- Keep it runnable with `eve eval --strict` and deterministic within its suite.
- World fixtures must not use live providers or model judges.
- World fixture root agents spread `e2eAgentConfig()` from
  `@eve-e2e/config` and declare `@eve-e2e/config` plus
  `@workflow/world-postgres` as direct dependencies.
- Do not add world configuration or Postgres dependencies to model-only
  fixtures.

Fixture discovery accepts `e2e/fixtures/*` and `apps/fixtures/*` apps with an
`evals/` directory. Shared development apps should stay out of the e2e matrix
unless they intentionally own evals.

## Postgres

Postgres e2e runs the 15 world fixtures against a self-hosted production server
backed by `@workflow/world-postgres`. Each leg owns an isolated PostgreSQL
service, bootstraps its schema, builds the fixture, starts it with `eve start`,
and targets that server with `eve eval --url`.

World fixture root agents spread `e2eAgentConfig()` from the private
`@eve-e2e/config` workspace package. The helper reads
`EVE_E2E_WORKFLOW_WORLD` into `experimental.workflow.world`. The variable is
unset in Local and Vercel, preserving their host defaults; Postgres sets it to
`@workflow/world-postgres` while compiling the production server. The world
package is a direct fixture dependency, pinned through the workspace catalog to
the same `@workflow/*` line as eve.

The per-fixture lifecycle is:

```sh
export EVE_E2E_WORKFLOW_WORLD="@workflow/world-postgres"
export EVE_MOCK_AUTHORED_MODELS="1"
export AI_GATEWAY_API_KEY="invalid-e2e-world-suite-key"
export WORKFLOW_POSTGRES_URL="postgres://world:world@127.0.0.1:5432/world"

pnpm exec bootstrap
pnpm exec eve build
pnpm exec eve start --host 127.0.0.1 --port 3000

# In a second process:
pnpm exec eve eval --strict --url http://127.0.0.1:3000
```

After the eval succeeds, CI requires at least one row in
`workflow.workflow_runs`. This proves the fixture used Postgres rather than
silently falling back to the local world. Dev-only schedule dispatch evals
skip against this production target, matching their Vercel behavior; the Local
world suite retains that development-route coverage.

## Vercel

Vercel e2e deploys the 15 world fixtures to immutable preview URLs. All fixture
deployments link to the same Vercel project id; isolation comes from the URL
returned by `vc deploy --prebuilt`.

One-time project setup:

- Configure the shared Vercel project for Node.js 24.
- Provide `VERCEL_TOKEN`, `VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID` in CI.

The workflow passes mock mode and the invalid Gateway credential to every
initial and in-test redeployment. Provider credentials are not required by the
world suite.

Run a world fixture against Vercel from its directory:

```sh
vc link --yes --project "$VERCEL_PROJECT_ID"
vc env pull --yes --environment=preview
VERCEL=1 VERCEL_ENV=preview VERCEL_TARGET_ENV=preview \
  VERCEL_PROJECT_ID="$VERCEL_PROJECT_ID" \
  EVE_MOCK_AUTHORED_MODELS=1 \
  AI_GATEWAY_API_KEY="invalid-e2e-world-suite-key" \
  pnpm exec eve build
DEPLOYMENT_URL="$(vc deploy --prebuilt --yes --target=preview \
  --env "EVE_MOCK_AUTHORED_MODELS=1" \
  --env "AI_GATEWAY_API_KEY=invalid-e2e-world-suite-key" | tail -n 1)"
npx eve eval --strict --url "$DEPLOYMENT_URL"
```

Do not set `VERCEL_TEAM_ID` at build: sandbox template keys must derive
identically at build and runtime, and Vercel has no team variable at runtime.

### Redeploy coverage

`agent-tools-sandbox/evals/sandbox/redeploy.eval.ts` proves sandbox semantics
across deployment updates as they behave on preview targets: a parked session
keeps working, with its `/workspace` state intact, when messages route through
a new deployment; its turns stay pinned to the deployment that created it; and
new sessions adopt the new deployment, where a newly added skill loads.
Branch-less CLI preview deploys cannot resolve a "latest" deployment, so the
pinned-turn assertion must be flipped when turn dispatch gains preview
latest-routing (https://github.com/vercel/eve/issues/582).

The eval redeploys from inside its test body: it mutates the agent source, runs
`eve build` plus `vc deploy`, and repoints a run-scoped Vercel alias at each new
deployment, polling `/eve/v1/info` until the alias serves it. Because immutable
deployment URLs never change what they serve, the eval runs against the alias.
The Vercel workflow propagates mock mode and the credential canary to each
redeployment.

## CI

The three workflows expose stable aggregate checks:

- `e2e-local` covers eight live-model legs and 15 Local world legs.
- `e2e-vercel` covers 15 Vercel world legs.
- `e2e-postgres` covers 15 Postgres world legs and persisted Workflow rows.

All three workflows run discovery even when a pull request is irrelevant, so
invalid suite ownership still fails. Their aggregate checks otherwise succeed
quickly on irrelevant changes and fail when discovery or any relevant matrix
leg fails. Require the three aggregate names in the repository ruleset; the
individual fixture jobs can change without updating required checks.

Local model legs export the selected provider id:

```sh
pnpm --filter eve run build
cd "$FIXTURE_DIR"
EVE_E2E_MODEL="$MODEL" pnpm exec eve eval --strict --junit "$JUNIT_PATH"
```

Every Local, Vercel, and Postgres world leg enables
`EVE_MOCK_AUTHORED_MODELS=1` and the invalid Gateway credential. Vercel passes
both variables to deployed functions and in-test redeployments; Postgres also
sets `EVE_E2E_WORKFLOW_WORLD=@workflow/world-postgres`.

Job names, JUnit files, server logs, and uploaded artifacts identify the suite,
world, fixture, and model where applicable. Always build with the full `build`
script rather than `build:js`; only the full build stamps the package version
into `dist`.

TUI smoke scripts are not e2e. They live under
`packages/eve/test/tui-client` and run through `pnpm test:tui`.
