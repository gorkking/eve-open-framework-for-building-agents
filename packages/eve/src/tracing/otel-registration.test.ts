import { describe, expect, it, vi } from "vitest";

import { registerOtelPipeline } from "#tracing/otel-registration.js";

const { registerOTel } = vi.hoisted(() => ({ registerOTel: vi.fn() }));

vi.mock("#compiled/@vercel/otel/index.js", () => ({ registerOTel }));

describe("registerOtelPipeline", () => {
  it("maps eve's option names onto the ones @vercel/otel accepts", () => {
    registerOTel.mockImplementation(() => undefined);

    expect(() =>
      registerOtelPipeline({
        options: {
          propagators: ["tracecontext"],
          resource: { "service.version": "abc" },
          sampler: "always_on",
        },
        serviceName: "weather",
      }),
    ).toThrow();

    expect(registerOTel).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: { "service.version": "abc" },
        autoDetectResources: false,
        instrumentations: [],
        propagators: expect.arrayContaining(["tracecontext", expect.any(Object)]),
        serviceName: "weather",
        traceSampler: "always_on",
      }),
    );
  });

  it("omits the sampler entirely rather than passing undefined", () => {
    registerOTel.mockImplementation(() => undefined);

    expect(() => registerOtelPipeline({ options: {}, serviceName: "weather" })).toThrow(
      /already owns the global tracer provider/u,
    );

    const configuration = registerOTel.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect("traceSampler" in configuration).toBe(false);
    // Absent propagators keep `"none"`; eve's private ownership marker follows it.
    expect(configuration["propagators"]).toEqual(["none", expect.any(Object)]);
  });

  it("filters the private registration span from authored processors", () => {
    const downstream = {
      forceFlush: vi.fn(async () => {}),
      onEnd: vi.fn(),
      onStart: vi.fn(),
      shutdown: vi.fn(async () => {}),
    };
    registerOTel.mockImplementation(() => undefined);

    expect(() =>
      registerOtelPipeline({
        options: { spanProcessors: [downstream] },
        serviceName: "weather",
      }),
    ).toThrow();

    const configuration = registerOTel.mock.calls.at(-1)?.[0] as {
      spanProcessors: {
        onEnd(span: unknown): void;
        onStart(span: unknown, parentContext: unknown): void;
      }[];
    };
    const processor = configuration.spanProcessors[0]!;
    processor.onStart({ name: "eve.otel.registration" }, {});
    processor.onEnd({ name: "eve.otel.registration" });
    processor.onStart({ name: "agent.turn" }, {});
    processor.onEnd({ name: "agent.turn" });

    expect(downstream.onStart).toHaveBeenCalledExactlyOnceWith({ name: "agent.turn" }, {});
    expect(downstream.onEnd).toHaveBeenCalledExactlyOnceWith({ name: "agent.turn" });
  });

  it("throws when the registration never reached a processor", () => {
    registerOTel.mockImplementation(() => undefined);

    expect(() => registerOtelPipeline({ options: {}, serviceName: "weather" })).toThrow(
      /another runtime already owns/u,
    );
  });
});
