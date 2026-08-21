import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { Client } from "../../src/client/index.js";
import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import {
  DEV_SERVER_SCENARIO_TIMEOUT_MS,
  TRANSACTIONAL_REBUILD_DESCRIPTOR,
} from "./dev-server-descriptors.js";
import {
  forceDevelopmentRebuild,
  startEveDev,
  waitForCondition,
  withinDeadline,
} from "./dev-server-harness.js";

const scenarioApp = useScenarioApp();

const DURABLE_FACTORY_SOURCE = `import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool as tool } from "eve/tools";
import { z } from "zod";

interface MarkerService {
  readonly createdInPid: number;
  readonly key: string;
}

const services = new Map<string, MarkerService>();

function writeMarker(phase: string, key: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(
    join(process.cwd(), ".dynamic-" + phase + "-" + key + ".json"),
    JSON.stringify({ ...extra, key, phase, pid: process.pid }),
  );
}

export function createDurableMarkerTool(key: string) {
  services.set(key, { createdInPid: process.pid, key });

  return tool({
    description: "Durable marker tool " + key + ".",
    inputSchema: z.object({ label: z.string().optional() }),
    approval: {
      request(context) {
        writeMarker("approval-request", key, { callId: context.callId });
        return "user-approval";
      },
      response(context) {
        writeMarker("approval-response", key, { decision: context.response.decision });
        return { status: "allowed" };
      },
    },
    execute(input) {
      const service = services.get(key);
      if (service === undefined) throw new Error("Missing live marker service for " + key + ".");
      const output = {
        key,
        label: input.label ?? "unlabeled",
        pid: process.pid,
        rawSecret: "raw-secret-" + key,
        serviceCreatedInPid: service.createdInPid,
      };
      writeMarker("execute", key, output);
      return output;
    },
    toModelOutput(output) {
      writeMarker("projection", key, {
        outputPid: output.pid,
        serviceCreatedInPid: output.serviceCreatedInPid,
      });
      return { type: "text", value: "projected-" + key };
    },
  });
}
`;

function createDynamicToolsSource(revision: string): string {
  return `import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { defineDynamic } from "eve/tools";
import { createDurableMarkerTool } from "../lib/durable-factory.ts";

const guardedMarker = createDurableMarkerTool("guarded-${revision}");
const companionMarker = createDurableMarkerTool("companion-${revision}");

export default defineDynamic({
  events: {
    "session.started": () => {
      appendFileSync(join(process.cwd(), ".dynamic-resolver-runs"), process.pid + "\\n");
      return {
        guarded_marker: guardedMarker,
        companion_marker: companionMarker,
      };
    },
  },
});
`;
}

const DYNAMIC_TOOL_COLD_REPLAY_DESCRIPTOR: ScenarioAppDescriptor = {
  ...TRANSACTIONAL_REBUILD_DESCRIPTOR,
  name: "dynamic-tool-cold-replay",
  files: {
    ...Object.fromEntries(
      Object.entries(TRANSACTIONAL_REBUILD_DESCRIPTOR.files).filter(
        ([path]) => path !== "agent/tools/get_weather.ts" && !path.startsWith("agent/skills/"),
      ),
    ),
    "agent/lib/durable-factory.ts": DURABLE_FACTORY_SOURCE,
    "agent/tools/durable-dynamic.ts": createDynamicToolsSource("a"),
  },
};

interface Marker {
  readonly key: string;
  readonly phase: string;
  readonly pid: number;
  readonly serviceCreatedInPid?: number;
}

async function readMarker(appRoot: string, phase: string, key: string): Promise<Marker> {
  return JSON.parse(
    await readFile(join(appRoot, `.dynamic-${phase}-${key}.json`), "utf8"),
  ) as Marker;
}

describe("dynamic tool cold replay", () => {
  it(
    "retains an originating definition across a rebuilt module and fresh process",
    async () => {
      const app = await scenarioApp(DYNAMIC_TOOL_COLD_REPLAY_DESCRIPTOR);
      const env = { WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS: "1" };
      let server = await startEveDev(app.appRoot, { env });
      let previousServerOutput = "";
      const complete = async <T>(operation: Promise<T>, stage: string): Promise<T> => {
        try {
          return await withinDeadline(operation, `Timed out during ${stage}.`, 45_000);
        } catch (error) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}\n\nprevious server:\n${previousServerOutput}\n\nstdout:\n${server.stdout()}\n\nstderr:\n${server.stderr()}`,
            { cause: error },
          );
        }
      };

      try {
        const client = new Client({ host: server.url });
        const created = await client.sessions.create({ message: "Hello." });
        await expect(
          complete(created.response.result(), "session creation"),
        ).resolves.toMatchObject({
          inputRequests: [],
          status: "waiting",
        });

        const waitingResponse = await created.session.send(
          "Call tools in parallel: guarded_marker, companion_marker",
        );
        const waiting = await complete(waitingResponse.result(), "originating approval requests");
        expect(waiting.status).toBe("waiting");
        expect(
          waiting.inputRequests,
          `Expected two approval requests.\n\nevents:\n${JSON.stringify(waiting.events, null, 2)}\n\nstdout:\n${server.stdout()}\n\nstderr:\n${server.stderr()}`,
        ).toHaveLength(2);

        const firstRequest = await readMarker(app.appRoot, "approval-request", "guarded-a");
        const resolverRunsBeforeRestart = (
          await readFile(join(app.appRoot, ".dynamic-resolver-runs"), "utf8")
        )
          .trim()
          .split("\n");
        expect(resolverRunsBeforeRestart).toHaveLength(1);
        const sessionState = created.session.state;

        // Shift every transformed callback's source coordinate and replace the
        // same model-visible names before resuming the parked generation.
        await writeFile(
          join(app.appRoot, "agent", "lib", "durable-factory.ts"),
          `\n\n${DURABLE_FACTORY_SOURCE}`,
        );
        await writeFile(
          join(app.appRoot, "agent", "tools", "durable-dynamic.ts"),
          createDynamicToolsSource("b"),
        );
        await complete(forceDevelopmentRebuild(server.url), "candidate generation rebuild");

        previousServerOutput = `stdout:\n${server.stdout()}\n\nstderr:\n${server.stderr()}`;
        await server.crash();
        await waitForCondition(async () => {
          try {
            await readFile(join(app.appRoot, ".eve", "dev-server-state.v1.json"));
            return false;
          } catch (error) {
            return error instanceof Error && "code" in error && error.code === "ENOENT";
          }
        }, "The crashed development server did not release its state record.");
        server = await startEveDev(app.appRoot, { env });

        const resumedSession = new Client({ host: server.url }).sessions.attach(
          sessionState.sessionId,
          { streamIndex: sessionState.streamIndex },
        );
        const resumedResponse = await resumedSession.respond(
          waiting.inputRequests.map((request) => ({
            optionId: "approve",
            requestId: request.requestId,
          })),
        );
        const resumed = await complete(resumedResponse.result(), "originating approval resume");
        expect(resumed.status).toBe("waiting");

        for (const key of ["guarded-a", "companion-a"]) {
          const response = await readMarker(app.appRoot, "approval-response", key);
          const execute = await readMarker(app.appRoot, "execute", key);
          const projection = await readMarker(app.appRoot, "projection", key);

          expect(response.pid).not.toBe(firstRequest.pid);
          expect(execute.pid).toBe(response.pid);
          expect(execute.serviceCreatedInPid).toBe(execute.pid);
          expect(projection.pid).toBe(execute.pid);
        }

        const resolverRunsAfterRestart = (
          await readFile(join(app.appRoot, ".dynamic-resolver-runs"), "utf8")
        )
          .trim()
          .split("\n");
        expect(resolverRunsAfterRestart).toEqual(resolverRunsBeforeRestart);

        const nextWaitingResponse = await resumedSession.send(
          "Call tools in parallel: guarded_marker, companion_marker",
        );
        const nextWaiting = await complete(
          nextWaitingResponse.result(),
          "replacement approval request",
        );
        expect(
          nextWaiting.inputRequests,
          `Expected replacement approval requests.\n\nevents:\n${JSON.stringify(nextWaiting.events, null, 2)}\n\nstdout:\n${server.stdout()}\n\nstderr:\n${server.stderr()}`,
        ).toHaveLength(2);
        const secondRequest = await readMarker(app.appRoot, "approval-request", "guarded-b");
        expect(secondRequest.pid).not.toBe(firstRequest.pid);

        const nextResponseStream = await resumedSession.respond(
          nextWaiting.inputRequests.map((request) => ({
            optionId: "approve",
            requestId: request.requestId,
          })),
        );
        const nextResult = await complete(
          nextResponseStream.result(),
          "replacement approval resume",
        );
        expect(nextResult.status).toBe("waiting");

        for (const key of ["guarded-b", "companion-b"]) {
          const nextResponse = await readMarker(app.appRoot, "approval-response", key);
          const nextExecute = await readMarker(app.appRoot, "execute", key);
          const nextProjection = await readMarker(app.appRoot, "projection", key);
          expect(nextResponse.pid).toBe(secondRequest.pid);
          expect(nextExecute.pid).toBe(secondRequest.pid);
          expect(nextProjection.pid).toBe(secondRequest.pid);
        }

        const resolverRunsAfterNextTurn = (
          await readFile(join(app.appRoot, ".dynamic-resolver-runs"), "utf8")
        )
          .trim()
          .split("\n");
        expect(resolverRunsAfterNextTurn).toHaveLength(2);
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );
});
