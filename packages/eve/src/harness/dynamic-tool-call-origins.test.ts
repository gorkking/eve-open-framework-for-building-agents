import { describe, expect, it } from "vitest";

import type { DurableDynamicToolMetadata } from "#context/keys.js";
import {
  addDynamicToolAuthorizationAttempts,
  createDynamicToolOriginState,
  readDynamicToolCallOrigin,
  reconcileDynamicToolCallOrigins,
  recordDynamicToolCallOrigin,
  releaseDynamicToolCallOrigin,
  releaseDynamicToolCallOriginsForTurn,
  resolveDynamicToolOriginDeployment,
} from "#harness/dynamic-tool-call-origins.js";

function definition(
  definitionId: string,
  name = "update",
  runtimeDeploymentId?: string,
): DurableDynamicToolMetadata {
  return {
    callbacks: {
      execute: { closure: { value: definitionId }, stepId: `execute-${definitionId}` },
    },
    definitionId,
    description: `Definition ${definitionId}`,
    entryKey: "update",
    event: "turn.started",
    inputSchema: { type: "object" },
    name,
    ownerId: "tenant-tools",
    resolverSlug: "tenant-tools",
    runtimeDeploymentId,
    runtimeRevision: "deployment:one",
    sourceId: "agent/tools/tenant.ts",
  };
}

function record(
  state: ReturnType<typeof createDynamicToolOriginState>,
  callId: string,
  snapshot: DurableDynamicToolMetadata = definition("definition-a"),
  turnId = "turn-a",
) {
  return recordDynamicToolCallOrigin(state, snapshot, {
    callId,
    originatingStepIndex: 2,
    originatingTurnId: turnId,
    toolName: snapshot.name,
  });
}

describe("dynamic tool call origins", () => {
  it("records one call and its referenced definition", () => {
    const state = record(createDynamicToolOriginState(), "call-a");

    expect(readDynamicToolCallOrigin(state, "call-a")).toEqual({
      callId: "call-a",
      definitionId: "definition-a",
      originatingStepIndex: 2,
      originatingTurnId: "turn-a",
      toolName: "update",
    });
    expect(state.definitions).toEqual({ "definition-a": definition("definition-a") });
  });

  it("shares one definition snapshot across calls", () => {
    const first = record(createDynamicToolOriginState(), "call-a");
    const second = record(first, "call-b");

    expect(Object.keys(second.calls)).toEqual(["call-a", "call-b"]);
    expect(Object.keys(second.definitions)).toEqual(["definition-a"]);
  });

  it("retains a shared definition until its last call is released", () => {
    const state = record(record(createDynamicToolOriginState(), "call-a"), "call-b");
    const retained = releaseDynamicToolCallOrigin(state, "call-a");
    const collected = releaseDynamicToolCallOrigin(retained, "call-b");

    expect(retained.calls).toEqual({
      "call-b": expect.objectContaining({ definitionId: "definition-a" }),
    });
    expect(retained.definitions).toHaveProperty("definition-a");
    expect(collected).toEqual(createDynamicToolOriginState());
  });

  it("merges authorization attempt ids without duplicates", () => {
    const state = record(createDynamicToolOriginState(), "call-a");
    const first = addDynamicToolAuthorizationAttempts(state, "call-a", ["attempt-a"]);
    const second = addDynamicToolAuthorizationAttempts(first, "call-a", ["attempt-a", "attempt-b"]);

    expect(second.calls["call-a"]?.authorizationAttemptIds).toEqual(["attempt-a", "attempt-b"]);
  });

  it("ignores a static tool without a definition snapshot", () => {
    const state = createDynamicToolOriginState();

    expect(
      recordDynamicToolCallOrigin(state, undefined, {
        callId: "call-static",
        originatingStepIndex: 0,
        originatingTurnId: "turn-a",
        toolName: "static",
      }),
    ).toBe(state);
  });

  it("releases only calls owned by a failed or cancelled turn", () => {
    const state = record(
      record(createDynamicToolOriginState(), "call-old", definition("old"), "turn-old"),
      "call-current",
      definition("current"),
      "turn-current",
    );

    const released = releaseDynamicToolCallOriginsForTurn(state, "turn-current");

    expect(Object.keys(released.calls)).toEqual(["call-old"]);
    expect(Object.keys(released.definitions)).toEqual(["old"]);
  });

  it("collects origins unreachable from pending approvals or authorization", () => {
    let state = record(createDynamicToolOriginState(), "call-approval", definition("approval"));
    state = record(state, "call-auth", definition("auth"));
    state = record(state, "call-orphan", definition("orphan"));
    state = addDynamicToolAuthorizationAttempts(state, "call-auth", ["attempt-auth"]);

    const reconciled = reconcileDynamicToolCallOrigins(state, {
      pendingAuthorizationAttemptIds: new Set(["attempt-auth"]),
      pendingCallIds: new Set(["call-approval"]),
    });

    expect(Object.keys(reconciled.calls)).toEqual(["call-approval", "call-auth"]);
    expect(Object.keys(reconciled.definitions)).toEqual(["approval", "auth"]);
  });

  it("selects the deployment for the call or authorization attempt being resumed", () => {
    let state = record(
      createDynamicToolOriginState(),
      "call-a",
      definition("definition-a", "update", "deployment-a"),
    );
    state = record(state, "call-b", definition("definition-b", "update", "deployment-b"), "turn-b");
    state = addDynamicToolAuthorizationAttempts(state, "call-b", ["attempt-b"]);

    expect(
      resolveDynamicToolOriginDeployment(state, {
        authorizationAttemptIds: new Set(),
        callIds: new Set(["call-a"]),
      }),
    ).toBe("deployment-a");
    expect(
      resolveDynamicToolOriginDeployment(state, {
        authorizationAttemptIds: new Set(["attempt-b"]),
        callIds: new Set(),
      }),
    ).toBe("deployment-b");
    expect(() =>
      resolveDynamicToolOriginDeployment(state, {
        authorizationAttemptIds: new Set(["attempt-b"]),
        callIds: new Set(["call-a"]),
      }),
    ).toThrow("spans multiple originating deployments");
  });

  it("fails closed when a matching origin has no deployment", () => {
    const state = record(createDynamicToolOriginState(), "call-a");

    expect(() =>
      resolveDynamicToolOriginDeployment(state, {
        authorizationAttemptIds: new Set(),
        callIds: new Set(["call-a"]),
      }),
    ).toThrow('Dynamic tool call "call-a" does not record an originating deployment');
  });

  it("fails closed for unknown versions and malformed references", () => {
    expect(() =>
      readDynamicToolCallOrigin({ calls: {}, definitions: {}, version: 2 } as never, "call-a"),
    ).toThrow("Unsupported dynamic tool call origin state version");

    expect(() =>
      readDynamicToolCallOrigin(
        {
          calls: {
            "call-a": {
              callId: "call-a",
              definitionId: "missing",
              originatingStepIndex: 0,
              originatingTurnId: "turn-a",
              toolName: "update",
            },
          },
          definitions: {},
          version: 1,
        },
        "call-a",
      ),
    ).toThrow('references missing definition "missing"');
  });
});
