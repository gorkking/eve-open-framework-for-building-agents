import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { installAgentInstrumentationRuntime } from "#tracing/agent-instrumentation-runtime.js";

describe("agent instrumentation runtime", () => {
  it("exports structural agent spans through an authored OTel provider", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    expect(trace.setGlobalTracerProvider(provider)).toBe(true);
    const runtime = installAgentInstrumentationRuntime({ frameworkVersion: "test" });

    await contextStorage.run(new ContextContainer(), async () => {
      await runtime.hooks.publish({
        agentName: "weather",
        rootSessionId: "session-1",
        sessionId: "session-1",
        type: "session.started",
      });
      await runtime.hooks.publish({
        rootSessionId: "session-1",
        sequence: 0,
        sessionId: "session-1",
        turnId: "turn-1",
        type: "turn.started",
      });
    });
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    expect(spans.map((span) => span.name)).toEqual(["agent.session", "agent.turn"]);
    expect(spans[1]?.attributes).toMatchObject({
      "agent.root.session.id": "session-1",
      "agent.session.id": "session-1",
      "agent.turn.id": "turn-1",
    });
  });
});
