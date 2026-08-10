import { describe, expect, it } from "vitest";

import {
  createServiceConfigRecord,
  parseVercelServicesConfig,
} from "#internal/vercel/vercel-services-config.js";

describe("parseVercelServicesConfig", () => {
  it("normalizes named service arrays", () => {
    const config = parseVercelServicesConfig(
      { services: [{ name: "eve", framework: "eve", root: "agent" }] },
      "vercel.json",
    );
    expect(createServiceConfigRecord(config.services)).toEqual({
      eve: { framework: "eve", root: "agent" },
    });
  });

  it.each([
    [null, /must contain a JSON object/],
    [{ services: null }, /services must be a JSON object or named service array/],
    [{ services: { eve: null } }, /service "eve" must contain a JSON object/],
    [{ services: [{}] }, /must have a non-empty name/],
    [{ routes: {} }, /routes must be an array/],
    [{ rewrites: {} }, /rewrites must be an array/],
  ])("rejects malformed configuration %#", (value, expected) => {
    expect(() => parseVercelServicesConfig(value, "vercel.json")).toThrow(expected);
  });
});
