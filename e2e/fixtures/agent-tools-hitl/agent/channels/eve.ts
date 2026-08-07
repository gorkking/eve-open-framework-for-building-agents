import type { AuthFn } from "eve/channels/auth";
import { none } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import type { SessionAuthContext } from "eve/context";

const PRINCIPAL_A_AUTHORIZATION = "Bearer e2e-hitl-principal-a";
const PRINCIPAL_B_AUTHORIZATION = "Bearer e2e-hitl-principal-b";

function principal(principalId: string): SessionAuthContext {
  return {
    attributes: {},
    authenticator: "e2e-hitl-bearer",
    issuer: "e2e",
    principalId,
    principalType: "user",
    subject: principalId,
  };
}

const authenticateA: AuthFn<Request> = (request) =>
  request.headers.get("authorization") === PRINCIPAL_A_AUTHORIZATION
    ? principal("e2e-hitl-a")
    : null;

const authenticateB: AuthFn<Request> = (request) =>
  request.headers.get("authorization") === PRINCIPAL_B_AUTHORIZATION
    ? principal("e2e-hitl-b")
    : null;

/** Fixture-only authentication for interactive authorization evals. */
const authenticateDefaultUser: AuthFn<Request> = (): SessionAuthContext => ({
  attributes: {},
  authenticator: "e2e-fixture",
  issuer: "e2e",
  principalId: "e2e-user",
  principalType: "user",
  subject: "e2e-user",
});

export default eveChannel({
  auth: [authenticateA, authenticateB, authenticateDefaultUser, none()],
});
