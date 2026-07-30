import { describe, expect, it, vi } from "vitest";

import { ChannelGateDeniedError, ChannelGateUnavailableError } from "#channel/gate-errors.js";
import {
  evaluateChannelReceiveGate,
  isChannelGateDecision,
  type ChannelGates,
} from "#channel/gates.js";

const payload = {
  auth: null,
  message: "hello",
  target: { channelId: "C1" },
} as const;

describe("channel gate decisions", () => {
  it("accepts only explicit tagged decisions", () => {
    expect(isChannelGateDecision({ type: "allow" })).toBe(true);
    expect(isChannelGateDecision({ type: "deny" })).toBe(true);
    expect(isChannelGateDecision({ reason: "private", type: "deny" })).toBe(true);
    expect(isChannelGateDecision(true)).toBe(false);
    expect(isChannelGateDecision(undefined)).toBe(false);
    expect(isChannelGateDecision({ reason: "extra", type: "allow" })).toBe(false);
    expect(isChannelGateDecision({ extra: true, type: "deny" })).toBe(false);
    expect(isChannelGateDecision({ reason: 403, type: "deny" })).toBe(false);
    expect(
      isChannelGateDecision(
        new Proxy(
          {},
          {
            ownKeys() {
              throw new Error("uninspectable");
            },
          },
        ),
      ),
    ).toBe(false);
  });

  it("allows an omitted receive gate", async () => {
    await expect(
      evaluateChannelReceiveGate({
        gate: undefined,
        payload,
        source: { name: "router", type: "channel" },
      }),
    ).resolves.toBeUndefined();
  });

  it("passes receive input and source metadata to an allowing gate", async () => {
    const gate = vi.fn<NonNullable<ChannelGates<void, { channelId: string }>["channel.receive"]>>(
      async () => ({ type: "allow" }),
    );

    await evaluateChannelReceiveGate({
      gate,
      payload,
      source: { name: "daily-summary", type: "schedule" },
    });

    expect(gate).toHaveBeenCalledWith(payload, {
      source: { name: "daily-summary", type: "schedule" },
    });
    expect(gate.mock.calls[0]?.[0]).not.toBe(payload);
  });

  it("discards input mutations made by a receive gate", async () => {
    await evaluateChannelReceiveGate({
      gate: async (input) => {
        (input.target as { channelId: string }).channelId = "mutated";
        return { type: "allow" };
      },
      payload,
      source: { name: "router", type: "channel" },
    });

    expect(payload.target.channelId).toBe("C1");
  });

  it("turns a denial into a typed error with the author-safe reason", async () => {
    await expect(
      evaluateChannelReceiveGate({
        gate: async () => ({ reason: "Target is private.", type: "deny" }),
        payload,
        source: { name: "router", type: "channel" },
      }),
    ).rejects.toMatchObject({
      gate: "channel.receive",
      name: "ChannelGateDeniedError",
      reason: "Target is private.",
    } satisfies Partial<ChannelGateDeniedError>);
  });

  it.each([
    ["a thrown callback", async () => Promise.reject(new Error("database offline"))],
    ["a malformed decision", async () => true as never],
  ])("fails closed for %s", async (_name, gate) => {
    await expect(
      evaluateChannelReceiveGate({
        gate,
        payload,
        source: { name: "router", type: "channel" },
      }),
    ).rejects.toBeInstanceOf(ChannelGateUnavailableError);
  });
});
