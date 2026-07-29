import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveLocalTraceSchemaDirectory } from "../../src/harness/local-trace-span-processor.js";
import { WEATHER_AGENT_DESCRIPTOR } from "../../src/internal/testing/scenario-apps/weather-agent.js";
import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import { sendDevelopmentMessage } from "../dev-client-harness/send-message.js";
import { createDevelopmentSessionState } from "../dev-client-harness/session.js";
import {
  fetchText,
  hasKnownDevServerFailure,
  startEveDev,
  waitForCondition,
} from "./dev-server-harness.js";

const scenarioApp = useScenarioApp();
const SCENARIO_TIMEOUT_MS = 360_000;
const AUTHORED_SPAN_LOG = ".authored-spans.log";

/**
 * An `agent/instrumentation.ts` of the shape the docs prescribe: `registerOTel`
 * with the author's own span processor, resolving `@vercel/otel` and
 * `@opentelemetry/api` from the agent's dependencies rather than eve's vendored
 * copies. `setup` is deliberately async — eve has to await it before installing
 * its writer, or it would register a provider ahead of this one.
 */
const AUTHORED_INSTRUMENTATION_SOURCE = `import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { defineInstrumentation } from "eve/instrumentation";
import { registerOTel } from "@vercel/otel";

const spanLogPath = join(process.cwd(), ${JSON.stringify(AUTHORED_SPAN_LOG)});

export default defineInstrumentation({
  setup: async ({ agentName }) => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    registerOTel({
      serviceName: agentName,
      spanProcessors: [
        {
          forceFlush: async () => {},
          onEnd: (span: { readonly name: string }) => {
            appendFileSync(spanLogPath, \`\${span.name}\\n\`);
          },
          onStart: () => {},
          shutdown: async () => {},
        },
      ],
    });
  },
});
`;

/**
 * A span of the author's own, created inside a turn from a tracer the author
 * asks the global API for. It should nest into the agent's trace and reach both
 * sinks — eve's writer accepts a whole agent-owned trace, not only the spans it
 * created itself.
 */
const AUTHORED_SPAN_TOOL_SOURCE = `import { defineTool } from "eve/tools";
import { trace } from "@opentelemetry/api";
import { z } from "zod";
import { createForecast } from "../lib/weather/client.ts";

export default defineTool({
  description: "Get the current weather for a city.",
  inputSchema: z.object({
    city: z.string(),
  }),
  async execute(input) {
    return trace.getTracer("weather-agent").startActiveSpan("authored.forecast", (span) => {
      try {
        return createForecast(input.city);
      } finally {
        span.end();
      }
    });
  },
});
`;

/**
 * The same thing outside any session. It belongs to no agent trace, so the
 * author's exporter is the only place it can appear: `eve trace` shows sessions,
 * and spooling unrelated request traffic to `.eve/traces/v1` would fill the
 * store with traces no session ever claims.
 */
const AUTHORED_SPAN_CHANNEL_SOURCE = `import { defineChannel, GET } from "eve/channels";
import { trace } from "@opentelemetry/api";

export default defineChannel({
  routes: [
    GET("/authored-span", () =>
      trace.getTracer("weather-agent").startActiveSpan("authored.channel", (span) => {
        span.end();
        return new Response("ok");
      }),
    ),
  ],
});
`;

const AUTHORED_INSTRUMENTATION_DESCRIPTOR: ScenarioAppDescriptor = {
  ...WEATHER_AGENT_DESCRIPTOR,
  dependencies: {
    ...WEATHER_AGENT_DESCRIPTOR.dependencies,
    "@opentelemetry/api": "1.9.1",
    "@vercel/otel": "2.1.3",
  },
  files: {
    ...WEATHER_AGENT_DESCRIPTOR.files,
    "agent/channels/authored-span.ts": AUTHORED_SPAN_CHANNEL_SOURCE,
    "agent/instrumentation.ts": AUTHORED_INSTRUMENTATION_SOURCE,
    "agent/tools/get_weather.ts": AUTHORED_SPAN_TOOL_SOURCE,
  },
  name: "authored-instrumentation-agent",
};

// The module-level tests cover the interception itself. What only a real
// `eve dev` can prove is the wiring around it: eve's two plugins bracketing the
// authored one in the generated `plugins.mjs`, the authored `setup` awaited
// before the writer is installed, and both sinks fed from one provider.
describe("authored instrumentation in eve dev", () => {
  it(
    "feeds the authored exporter and the local trace store from the same provider",
    async () => {
      const app = await scenarioApp(AUTHORED_INSTRUMENTATION_DESCRIPTOR);
      const spanLogPath = join(app.appRoot, AUTHORED_SPAN_LOG);
      const server = await startEveDev(app.appRoot);
      const output = (): string => `stdout:\n${server.stdout()}\n\nstderr:\n${server.stderr()}`;

      try {
        const result = await sendDevelopmentMessage({
          message: "What is the weather in Lisbon?",
          session: createDevelopmentSessionState(),
          serverUrl: server.url,
        });
        expect(
          result.events.some((event) => event.type === "message.completed"),
          `Expected the streamed turn to complete.\n\n${output()}`,
        ).toBe(true);

        // The authored processor is still the one the provider reports to, and
        // it now also receives eve's own agent spans — which it never saw while
        // the local writer stood down in the presence of this file.
        let authoredSpans: string[] = [];
        await waitForCondition(
          async () => {
            authoredSpans = await readAuthoredSpanNames(spanLogPath);
            return authoredSpans.includes("agent.turn");
          },
          () =>
            `Authored span processor never received eve's agent spans.\n\nspans: ${JSON.stringify(
              authoredSpans,
            )}\n\n${output()}`,
        );

        // The author's own span, created from the global API inside the turn,
        // arrives there too.
        expect(
          authoredSpans,
          `Authored span processor never received the tool's own span.\n\nspans: ${JSON.stringify(
            authoredSpans,
          )}\n\n${output()}`,
        ).toContain("authored.forecast");

        // ...and eve spooled the same spans to the local store, so `eve trace`
        // keeps working for an agent that authored instrumentation.
        let localTraces: LocalTrace[] = [];
        await waitForCondition(
          async () => {
            localTraces = await readLocalTraces(app.appRoot);
            return localTraces.some((trace) => trace.spanNames.includes("agent.turn"));
          },
          () =>
            `Local trace store never received eve's agent spans.\n\ntraces: ${JSON.stringify(
              localTraces,
            )}\n\n${output()}`,
        );

        // One trace, not two: the author's span nests into the agent's trace
        // rather than starting a root of its own, which is what makes it show up
        // under `agent.step` in `eve trace`.
        const agentTrace = localTraces.find((trace) => trace.spanNames.includes("agent.turn"));
        await waitForCondition(
          async () => {
            localTraces = await readLocalTraces(app.appRoot);
            return (
              localTraces
                .find((trace) => trace.traceId === agentTrace?.traceId)
                ?.spanNames.includes("authored.forecast") === true
            );
          },
          () =>
            `Local trace store never received the tool's own span in the agent trace.\n\ntraces: ${JSON.stringify(
              localTraces,
            )}\n\n${output()}`,
        );

        // A span outside any session belongs to no agent trace, so it reaches
        // the author's exporter and nothing else. Asserted only once the author
        // has it: eve's accept decision is made when the span ends, so by then
        // the local store has already declined it.
        await fetchText(server.url, "/authored-span");
        await waitForCondition(
          async () => {
            authoredSpans = await readAuthoredSpanNames(spanLogPath);
            return authoredSpans.includes("authored.channel");
          },
          () =>
            `Authored span processor never received the channel's span.\n\nspans: ${JSON.stringify(
              authoredSpans,
            )}\n\n${output()}`,
        );
        localTraces = await readLocalTraces(app.appRoot);
        expect(localTraces.flatMap((trace) => trace.spanNames)).not.toContain("authored.channel");

        expect(output()).not.toContain("could not register an OpenTelemetry tracer provider");
        expect(hasKnownDevServerFailure(output())).toBe(false);
      } finally {
        await server.stop();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );
});

async function readAuthoredSpanNames(spanLogPath: string): Promise<string[]> {
  try {
    return (await readFile(spanLogPath, "utf8")).split("\n").filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

interface OtlpSegment {
  readonly resourceSpans?: readonly {
    readonly scopeSpans?: readonly {
      readonly spans?: readonly { readonly name?: string }[];
    }[];
  }[];
}

interface LocalTrace {
  readonly spanNames: readonly string[];
  readonly traceId: string;
}

async function readLocalTraces(appRoot: string): Promise<LocalTrace[]> {
  const schemaDirectory = resolveLocalTraceSchemaDirectory(appRoot);
  const traces: LocalTrace[] = [];

  for (const traceId of await listDirectory(schemaDirectory)) {
    const segmentsDirectory = join(schemaDirectory, traceId, "segments");
    const spanNames: string[] = [];
    for (const segment of await listDirectory(segmentsDirectory)) {
      const payload = await readSegment(join(segmentsDirectory, segment));
      for (const resourceSpan of payload?.resourceSpans ?? []) {
        for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
          for (const span of scopeSpan.spans ?? []) {
            if (span.name !== undefined) spanNames.push(span.name);
          }
        }
      }
    }
    traces.push({ spanNames, traceId });
  }

  return traces;
}

async function listDirectory(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch {
    return [];
  }
}

async function readSegment(path: string): Promise<OtlpSegment | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as OtlpSegment;
  } catch {
    return undefined;
  }
}
