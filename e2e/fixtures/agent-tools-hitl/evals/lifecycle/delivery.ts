import type { InputResponse } from "eve/client";
import type { EveEvalContext, EveEvalTurn } from "eve/evals";

export interface CompoundDeliveryResult {
  readonly session: EveEvalContext;
  readonly turn: EveEvalTurn;
}

export async function respondToRequests(
  t: EveEvalContext,
  ...responses: InputResponse[]
): Promise<EveEvalTurn> {
  return await t.respond(...responses);
}

export async function sendAs(
  t: EveEvalContext,
  message: string,
  authorization: string,
): Promise<EveEvalTurn> {
  return await t.send({ headers: { authorization }, message });
}

export async function respondAs(
  t: EveEvalContext,
  response: InputResponse,
  authorization: string,
): Promise<EveEvalTurn> {
  return await t.send({
    headers: { authorization },
    inputResponses: [response],
  });
}

export async function sendCompoundDelivery(
  t: EveEvalContext,
  input: {
    readonly inputResponses: readonly InputResponse[];
    readonly message: string;
  },
): Promise<CompoundDeliveryResult> {
  return { session: t, turn: await t.send(input) };
}
