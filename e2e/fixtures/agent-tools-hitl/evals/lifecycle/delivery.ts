import type { InputResponse } from "eve/client";
import type { EveEvalContext, EveEvalSession, EveEvalTurn } from "eve/evals";

export interface CompoundDeliveryResult {
  readonly session: EveEvalSession;
  readonly turn: EveEvalTurn;
}

/** Respond through either side of the eval driver's pending session-API migration. */
export async function respondToRequests(
  t: EveEvalContext,
  ...responses: InputResponse[]
): Promise<EveEvalTurn> {
  const args: unknown[] = t.respond.length === 0 ? responses : [responses];
  return (await Reflect.apply(t.respond, t, args)) as EveEvalTurn;
}

export async function sendAs(
  t: EveEvalContext,
  message: string,
  authorization: string,
): Promise<EveEvalTurn> {
  const options = { headers: { authorization } };
  const args: unknown[] = t.send.length === 1 ? [{ message, ...options }] : [message, options];
  return (await Reflect.apply(t.send, t, args)) as EveEvalTurn;
}

export async function respondAs(
  t: EveEvalContext,
  response: InputResponse,
  authorization: string,
): Promise<EveEvalTurn> {
  const options = { headers: { authorization } };
  if (t.respond.length === 0) {
    return (await Reflect.apply(t.send, t, [
      { inputResponses: [response], ...options },
    ])) as EveEvalTurn;
  }
  return (await Reflect.apply(t.respond, t, [[response], options])) as EveEvalTurn;
}

/** Sends the compound delivery shape intentionally absent from the high-level client API. */
export async function sendCompoundDelivery(
  t: EveEvalContext,
  input: {
    readonly inputResponses: readonly InputResponse[];
    readonly message: string;
  },
): Promise<CompoundDeliveryResult> {
  const sessionId = t.sessionId;
  const state = t.state as
    | { readonly continuationToken?: unknown; readonly streamIndex?: unknown }
    | undefined;
  if (sessionId === undefined || typeof state?.streamIndex !== "number") {
    throw new Error("Compound delivery requires an existing eval session and stream cursor.");
  }

  const continuationToken = state.continuationToken;
  const body =
    typeof continuationToken === "string" && continuationToken.length > 0
      ? { ...input, continuationToken }
      : input;
  const path = `/eve/v1/session/${encodeURIComponent(sessionId)}`;
  const response = await t.target.fetch(path, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: t.signal,
  });
  if (!response.ok) {
    throw new Error(
      `Compound delivery failed (${String(response.status)}): ${await response.text()}`,
    );
  }

  const live = t.target.watchTurn(sessionId, { startIndex: state.streamIndex });
  return { session: live.session, turn: await live.result() };
}
