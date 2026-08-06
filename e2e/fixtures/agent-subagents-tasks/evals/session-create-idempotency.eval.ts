import { defineEval, type EveEvalTargetHandle } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

interface CreateSessionResponse {
  readonly continuationToken: string;
  readonly ok: true;
  readonly sessionId: string;
}

const PRINCIPAL_A = "Bearer e2e-task-operation-a";
const PRINCIPAL_B = "Bearer e2e-task-operation-b";

/** Retried remote create is idempotent and scoped to its transport principal. */
export default defineEval({
  description:
    "An operationId returns one active session per authenticated principal across retried creates.",
  async test(t) {
    const operationId = `session-create-idempotency-${crypto.randomUUID()}`;
    const first = await createSession(t.target, PRINCIPAL_A, operationId, "first create");
    const replay = await createSession(t.target, PRINCIPAL_A, operationId, "replayed create");
    const otherPrincipal = await createSession(
      t.target,
      PRINCIPAL_B,
      operationId,
      "other principal",
    );

    await t.require(replay.sessionId, equals(first.sessionId));
    await t.require(replay.continuationToken, equals(first.continuationToken));
    await t.require(
      otherPrincipal,
      satisfies(
        (value: CreateSessionResponse) =>
          value.sessionId !== first.sessionId &&
          value.continuationToken !== first.continuationToken,
        "the same operation id under another principal creates a distinct session",
      ),
    );

    const [firstTurn, otherTurn] = await Promise.all([
      t.target.watchTurn(first.sessionId).result(),
      t.target.watchTurn(otherPrincipal.sessionId).result(),
    ]);
    firstTurn.expectOk();
    otherTurn.expectOk();
  },
});

async function createSession(
  target: EveEvalTargetHandle,
  authorization: string,
  operationId: string,
  message: string,
): Promise<CreateSessionResponse> {
  const response = await target.fetch("/eve/v1/session", {
    body: JSON.stringify({ message, operationId }),
    headers: { authorization, "content-type": "application/json" },
    method: "POST",
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`POST /eve/v1/session failed (${response.status}): ${text}`);
  }
  return JSON.parse(text) as CreateSessionResponse;
}
