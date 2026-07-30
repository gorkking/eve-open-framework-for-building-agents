import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

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
  type RunningEveDev,
} from "./dev-server-harness.js";

const scenarioApp = useScenarioApp();

const DRAIN_SCENARIO_TIMEOUT_MS = 360_000;

const DRAIN_CHANNEL_SOURCE = [
  'import { randomUUID } from "node:crypto";',
  'import { defineChannel, GET } from "eve/channels";',
  "",
  "const workerId = randomUUID();",
  "",
  "export default defineChannel({",
  "  routes: [",
  '    GET("/drain/worker-id", () => new Response(workerId)),',
  '    GET("/drain/slow-stream", () => {',
  "      let timer: ReturnType<typeof setInterval> | undefined;",
  "      const body = new ReadableStream({",
  "        start(controller) {",
  '          controller.enqueue(new TextEncoder().encode("chunk\\n"));',
  "          timer = setInterval(() => {",
  '            controller.enqueue(new TextEncoder().encode("chunk\\n"));',
  "          }, 50);",
  "        },",
  "        cancel() {",
  "          clearInterval(timer);",
  "        },",
  "      });",
  "      return new Response(body);",
  "    }),",
  "  ],",
  "});",
  "",
].join("\n");

const DRAIN_DESCRIPTOR: ScenarioAppDescriptor = {
  ...WEATHER_AGENT_DESCRIPTOR,
  files: {
    ...WEATHER_AGENT_DESCRIPTOR.files,
    "agent/channels/drain.ts": DRAIN_CHANNEL_SOURCE,
  },
  name: "weather-agent-drain",
};

async function triggerWorkerReplacement(server: RunningEveDev, appRoot: string): Promise<void> {
  const previousWorkerId = await fetchText(server.url, "/drain/worker-id");
  await writeFile(join(appRoot, ".env.local"), `EVE_DRAIN_RELOAD=${Date.now()}\n`);
  await waitForCondition(
    async () => {
      try {
        return (await fetchText(server.url, "/drain/worker-id")) !== previousWorkerId;
      } catch {
        return false;
      }
    },
    () =>
      [
        "Timed out waiting for a replacement worker.",
        `stdout:\n${server.stdout()}`,
        `stderr:\n${server.stderr()}`,
      ].join("\n\n"),
  );
}

describe("eve dev drained worker replacement", () => {
  it(
    "keeps an admitted stream flowing on the retired worker across a replacement",
    async () => {
      const app = await scenarioApp(DRAIN_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);

      try {
        const streamResponse = await fetch(new URL("/drain/slow-stream", server.url));
        const reader = streamResponse.body?.getReader();
        await reader?.read();

        await triggerWorkerReplacement(server, app.appRoot);

        // The retired worker must still be producing: several further chunks
        // arrive after the swap, then the client walks away cleanly.
        for (let i = 0; i < 5; i += 1) {
          const result = await reader?.read();
          expect(result?.done).toBe(false);
        }
        await reader?.cancel();

        const turn = await sendDevelopmentMessage({
          message: "What's the weather in Lisbon?",
          session: createDevelopmentSessionState(),
          serverUrl: server.url,
        });
        expect(turn.events.some((event) => event.type === "message.completed")).toBe(true);
        expect(hasKnownDevServerFailure(`${server.stdout()}\n${server.stderr()}`)).toBe(false);
      } finally {
        await server.stop();
      }
    },
    DRAIN_SCENARIO_TIMEOUT_MS,
  );
});
