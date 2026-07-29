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
import { hasKnownDevServerFailure, startEveDev, waitForCondition } from "./dev-server-harness.js";

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

const AUTHORED_INSTRUMENTATION_DESCRIPTOR: ScenarioAppDescriptor = {
  ...WEATHER_AGENT_DESCRIPTOR,
  dependencies: {
    ...WEATHER_AGENT_DESCRIPTOR.dependencies,
    "@vercel/otel": "2.1.3",
  },
  files: {
    ...WEATHER_AGENT_DESCRIPTOR.files,
    "agent/instrumentation.ts": AUTHORED_INSTRUMENTATION_SOURCE,
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

        // ...and eve spooled the same span to the local store, so `eve trace`
        // keeps working for an agent that authored instrumentation.
        let localSpans: string[] = [];
        await waitForCondition(
          async () => {
            localSpans = await readLocalTraceSpanNames(app.appRoot);
            return localSpans.includes("agent.turn");
          },
          () =>
            `Local trace store never received eve's agent spans.\n\nspans: ${JSON.stringify(
              localSpans,
            )}\n\n${output()}`,
        );

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

async function readLocalTraceSpanNames(appRoot: string): Promise<string[]> {
  const schemaDirectory = resolveLocalTraceSchemaDirectory(appRoot);
  const traceIds = await listDirectory(schemaDirectory);
  const names: string[] = [];

  for (const traceId of traceIds) {
    const segmentsDirectory = join(schemaDirectory, traceId, "segments");
    for (const segment of await listDirectory(segmentsDirectory)) {
      const payload = await readSegment(join(segmentsDirectory, segment));
      for (const resourceSpan of payload?.resourceSpans ?? []) {
        for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
          for (const span of scopeSpan.spans ?? []) {
            if (span.name !== undefined) names.push(span.name);
          }
        }
      }
    }
  }

  return names;
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
