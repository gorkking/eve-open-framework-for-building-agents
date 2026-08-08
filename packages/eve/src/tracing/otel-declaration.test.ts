import type { SpanProcessor } from "#compiled/@vercel/otel/index.js";
import { describe, expect, it } from "vitest";

import { isOtelDeclaration, mergeOtelDeclarations, otel } from "#tracing/otel-declaration.js";

/** The merge only ever moves processors, so a fresh no-op is identity enough. */
function processor(): SpanProcessor {
  return {
    forceFlush: async () => undefined,
    onEnd: () => undefined,
    onStart: () => undefined,
    shutdown: async () => undefined,
  };
}

describe("otel", () => {
  it("declares a pipeline without registering anything", () => {
    const declaration = otel({ spanProcessors: [processor()] });
    expect(isOtelDeclaration(declaration)).toBe(true);
    expect(isOtelDeclaration({ options: {} })).toBe(false);
  });
});

describe("mergeOtelDeclarations", () => {
  it("is absent when nothing declared a pipeline", () => {
    expect(mergeOtelDeclarations([])).toBeUndefined();
  });

  it("concatenates span processors in declaration order", () => {
    const [first, second, third] = [processor(), processor(), processor()];
    const merged = mergeOtelDeclarations([
      otel({ spanProcessors: [first, second] }),
      otel({ spanProcessors: [third] }),
      otel(),
    ]);

    expect(merged?.spanProcessors).toStrictEqual([first, second, third]);
  });

  it("carries a singleton declared exactly once", () => {
    const merged = mergeOtelDeclarations([
      otel({ sampler: "always_on" }),
      otel({ propagators: ["tracecontext"] }),
      otel({ resource: { "service.version": "abc" } }),
    ]);

    expect(merged).toMatchObject({
      propagators: ["tracecontext"],
      resource: { "service.version": "abc" },
      sampler: "always_on",
    });
  });

  // A process has one tracer provider, so letting the first declaration win
  // would silently discard the second — the failure this throw exists to stop.
  it.each([
    { key: "resource", one: otel({ resource: { a: "1" } }), two: otel({ resource: { b: "2" } }) },
    { key: "sampler", one: otel({ sampler: "always_on" }), two: otel({ sampler: "always_off" }) },
    {
      key: "propagators",
      one: otel({ propagators: ["tracecontext"] }),
      two: otel({ propagators: ["baggage"] }),
    },
  ])("refuses a second $key rather than picking one", ({ key, one, two }) => {
    expect(() => mergeOtelDeclarations([one, two])).toThrow(
      new RegExp(`declares \`${key}\` in more than one`, "u"),
    );
  });

  it("names both declarations in the collision, so the author can find them", () => {
    expect(() =>
      mergeOtelDeclarations([
        otel(),
        otel({ sampler: "always_on" }),
        otel({ sampler: "always_off" }),
      ]),
    ).toThrow(/\(1 and 2\)/u);
  });
});
