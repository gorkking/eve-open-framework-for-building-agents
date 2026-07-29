# e2e

End-to-end coverage is fixture-owned `eve eval` runs. The suite only runs
fixture eval files from the fixture directory.

## Local

Run evals from the fixture directory:

```sh
cd e2e/fixtures/agent-basic-runtime
EVE_E2E_MODEL="openai/gpt-5.6-sol" pnpm exec eve eval --strict
```

Every retained e2e eval is deterministic and self-contained. Eval files do
not start external services or require fixture-specific injected env. The CI
harness may provide world-level infrastructure, such as the ephemeral
PostgreSQL service used by the Postgres matrix. Most fixtures use the shared
model-provider credentials; dedicated runtime stress fixtures may use an
authored deterministic model instead.

Each retained fixture package also exposes the same command as:

```sh
pnpm --filter agent-basic-runtime test:e2e
```

The root convenience command runs every fixture package with a `test:e2e`
script:

```sh
pnpm test:e2e
```

## Postgres

Postgres e2e runs the same fixture evals against a self-hosted production
server backed by `@workflow/world-postgres`. Each matrix leg owns an isolated
PostgreSQL service, bootstraps its schema, builds the fixture, starts it with
`eve start`, and targets that server with `eve eval --url`.

Fixture root agents spread `e2eAgentConfig()` from the private
`@eve-e2e/config` workspace package. The helper selects the root agent model
from `EVE_E2E_MODEL` and reads `EVE_E2E_WORKFLOW_WORLD` into
`experimental.workflow.world`. The world variable is unset in the local and
Vercel suites, preserving their host defaults; the Postgres workflow sets it
to `@workflow/world-postgres` while compiling the production server. The world
package remains a direct fixture dependency, pinned through the workspace
catalog to the same `@workflow/*` line as eve.

The per-fixture lifecycle is:

```sh
export EVE_E2E_WORKFLOW_WORLD="@workflow/world-postgres"
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
skip against this production target, matching their Vercel behavior; the
local matrix retains that development-route coverage.

## Vercel

Vercel e2e uses the same fixture evals against immutable preview deployment
URLs. All fixture deployments link to the same Vercel project id; isolation
comes from the deployment URL returned by `vc deploy --prebuilt`.

One-time project setup:

- Configure the shared Vercel project for Node.js 24.
- Provide the model-provider credentials needed by `EVE_E2E_MODEL` in the
  project's Preview environment.
- Provide `VERCEL_TOKEN`, `VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID` in CI.

Run a fixture against Vercel from its directory:

```sh
vc link --yes --project "$VERCEL_PROJECT_ID"
vc env pull --yes --environment=preview
VERCEL=1 VERCEL_ENV=preview VERCEL_TARGET_ENV=preview \
  VERCEL_PROJECT_ID="$VERCEL_PROJECT_ID" \
  pnpm exec eve build
DEPLOYMENT_URL="$(vc deploy --prebuilt --yes --target=preview \
  --env "EVE_E2E_MODEL=$EVE_E2E_MODEL" | tail -n 1)"
npx eve eval --strict --url "$DEPLOYMENT_URL"
```

Do not set `VERCEL_TEAM_ID` at build: sandbox template keys must derive
identically at build and runtime, and Vercel has no team variable at runtime.

### Redeploy suite

`agent-tools-sandbox/evals/sandbox/redeploy.eval.ts` proves sandbox semantics
across deployment updates as they behave on preview targets: a parked session
keeps working (with its `/workspace` state intact) when messages route through
a new deployment, its turns stay pinned to the deployment that created it
(branch-less CLI preview deploys cannot resolve a "latest" deployment; see
`shouldRouteToLatestDeployment` in `execution/workflow-runtime.ts`), and new
sessions adopt the new deployment — a skill added by the redeploy loads there.
The pinned-turn assertion is a deliberate tripwire: it must be flipped when
turn dispatch gains preview latest-routing
(https://github.com/vercel/eve/issues/582).

The eval redeploys from inside its test body: it mutates the agent source,
runs `eve build` + `vc deploy`, and repoints a run-scoped Vercel alias at
each new deployment, polling `/eve/v1/info` until the alias serves it.
Because immutable deployment URLs never change what they serve, the eval
must run against the alias — the `e2e-vercel` workflow sets
`EVE_E2E_REDEPLOY_ALIAS`, aliases the deployment, and runs `--tag redeploy`
evals as a second `eve eval` invocation after the main suite. Without the
alias env (local matrix, plain `eve eval --strict`) the eval skips.

Most fixture agents and their configured judges use `EVE_E2E_MODEL`, defaulting
to `openai/gpt-5.6-sol` for local runs. CI sets it from the model matrix, so
adding a matrix entry runs every discovered fixture against that model.
`agent-prompt-cache` is the one fixture that authors a direct
`@ai-sdk/anthropic` model instance instead of a gateway model id: its eval
asserts the harness's Anthropic cache-breakpoint placement, which only runs on
that path. It uses the matrix model when it is an Anthropic model and otherwise
falls back to `anthropic/claude-opus-5`. The instance points at the AI
Gateway's Anthropic-compatible Messages endpoint so it uses the same
`AI_GATEWAY_API_KEY` credential as every other fixture.
`agent-workflow-stress` uses eve's `mockModel` fixture helper so its 100-turn
runs stay fast and deterministic. Its concurrent and sequential evals cover
high-volume session execution and repeated session resumption respectively.

## Fixtures

E2E fixtures live under `e2e/fixtures/*`. Fixture discovery also accepts
`apps/fixtures/*` apps with an `evals/` directory, but shared development apps
should stay out of the e2e matrix unless they intentionally own evals.

When adding e2e coverage:

- Put the eval in the fixture app's `evals/` directory.
- Keep it runnable with only `eve eval --strict`.
- Keep it deterministic: no external service startup or injected env
  requirements (beyond model-provider credentials).
- Spread `e2eAgentConfig()` from `@eve-e2e/config` in the root `agent.ts`.
- Declare `@eve-e2e/config` and `@workflow/world-postgres` as direct
  dependencies.
- If the behavior cannot fit that shape yet, leave it out and rebuild it later
  as a first-class eval story.

## CI

`.github/workflows/e2e-local.yml` builds the eve package once per matrix leg,
then runs one fixture directory. Its matrix crosses every discovered fixture
with these model entries:

- `openai-sol` → `openai/gpt-5.6-sol`
- `anthropic-opus` → `anthropic/claude-opus-5`

The short name is the stable Actions check identifier; the full id selects the
provider model. Updating a model version does not rename required checks.
Each workflow also publishes one stable aggregate check: `e2e-local`,
`e2e-postgres`, or `e2e-vercel`. Each aggregate succeeds only when every
fixture and model leg succeeds. Require all three checks in the repository
ruleset so newly added fixtures and models become required automatically.

Each leg exports the selected id as `EVE_E2E_MODEL` before it runs:

```sh
pnpm --filter eve run build
cd "$FIXTURE_DIR"
EVE_E2E_MODEL="$MODEL" pnpm exec eve eval --strict --junit "$JUNIT_PATH"
```

Always build with the full `build` script (not `build:js`); only the full
build stamps the package version into `dist`.

`.github/workflows/e2e-vercel.yml` links each fixture directory to the shared
Vercel project id, builds Vercel output locally, deploys that output, and runs:

```sh
pnpm exec eve build
DEPLOYMENT_URL="$(vc deploy --prebuilt --yes --target=preview \
  --env "EVE_E2E_MODEL=$EVE_E2E_MODEL" | tail -n 1)"
npx eve eval --strict --url "$DEPLOYMENT_URL" --junit "$JUNIT_PATH"
```

`.github/workflows/e2e-postgres.yml` starts PostgreSQL as a job service and
runs a self-hosted production build:

```sh
pnpm exec bootstrap
pnpm exec eve build
pnpm exec eve start --host 127.0.0.1 --port 3000
pnpm exec eve eval --strict --url http://127.0.0.1:3000 --junit "$JUNIT_PATH"
```

The Postgres matrix skips at the job level on irrelevant changes so those PRs
do not start service containers. Its stable aggregate check still reports and
succeeds on every PR.

TUI smoke scripts are not e2e. They live under
`packages/eve/test/tui-client` and run through `pnpm test:tui`.
