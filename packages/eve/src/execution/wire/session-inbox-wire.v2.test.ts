import { describe, expect, it } from "vitest";

import { sessionInboxWire as encoder } from "#execution/wire/session-inbox-encoder.js";
import { sessionInboxWire as decoder } from "#execution/wire/session-inbox-wire.js";
import { sessionInboxWireV2Schema } from "#execution/wire/session-inbox-wire.v2.js";

describe("session inbox wire v2", () => {
  it("accepts only version 2", () => {
    expect(sessionInboxWireV2Schema.safeParse({ kind: "clear", version: 2 }).success).toBe(true);
    expect(sessionInboxWireV2Schema.safeParse({ kind: "clear", version: 1 }).success).toBe(false);
  });

  it("encodes and decodes progress commands", () => {
    const command = {
      commandId: "progress-1",
      events: [],
      kind: "progress" as const,
      version: 1 as const,
    };
    const wire = encoder.encode(command, { version: 2 });
    expect(wire).toEqual({ ...command, version: 2 });
    expect(decoder.decode(wire)).toEqual(command);
  });

  it("migrates version 1 controls", () => {
    expect(decoder.decode({ kind: "clear", version: 1 })).toEqual({ kind: "clear" });
  });
});
