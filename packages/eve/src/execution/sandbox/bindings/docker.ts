import { randomUUID } from "node:crypto";

import {
  DOCKER_SANDBOX_LABEL,
  runDockerBaseSetup,
  startDockerContainer,
  stopDockerContainerIfRunning,
} from "#execution/sandbox/bindings/docker-container.js";
import {
  assertDockerDaemonAvailable,
  createDockerCli,
  type DockerCli,
} from "#execution/sandbox/bindings/docker-cli.js";
import { setDockerNetworkPolicy } from "#execution/sandbox/bindings/docker-network.js";
import {
  createDockerSandboxOptionsHash,
  resolveDockerSandboxOptions,
} from "#execution/sandbox/bindings/docker-options.js";
import { createDockerInternalSession } from "#execution/sandbox/bindings/docker-session.js";
import {
  dockerImageExists,
  dockerTemplateImageReference,
  ensureDockerBaseImage,
  resolveDockerTemplateMarkerPath,
  touchDockerTemplateMarker,
} from "#execution/sandbox/bindings/docker-templates.js";
import { expectDockerSuccess } from "#execution/sandbox/bindings/docker-utils.js";
import { writeSandboxSeedFiles } from "#execution/sandbox/bindings/local-workspace-utils.js";
import { createLoggingSandboxSession } from "#execution/sandbox/logging-session.js";
import { buildSandboxSession } from "#execution/sandbox/session.js";
import type {
  SandboxEngine,
  SandboxEngineCreateInput,
  SandboxEngineHandle,
  SandboxEnginePrepareInput,
  SandboxEnginePrepareResult,
} from "#shared/sandbox-engine.js";
import {
  SandboxResourceUnavailableError,
  SandboxTemplateUnavailableError,
} from "#shared/sandbox-engine.js";
import { parseJsonObject } from "#shared/json.js";
import type { DockerSandboxCreateOptions } from "#public/sandbox/docker-sandbox.js";

export {
  DOCKER_TEMPLATE_IMAGE_REPOSITORY,
  pruneDockerSandboxTemplates,
} from "#execution/sandbox/bindings/docker-templates.js";

/**
 * Stable provider name. Participates in template/session key derivation
 * and persisted reconnect state.
 */
export const DOCKER_PROVIDER = "docker";

/**
 * Construction input for the internal Docker bridge behind
 * `DockerSandbox`.
 */
export interface CreateDockerSandboxEngineInput {
  readonly createOptions?: DockerSandboxCreateOptions;
  /** Injectable Docker driver so provider logic is testable without a daemon. */
  readonly dockerCli?: DockerCli;
}

/**
 * Creates the Docker sandbox provider.
 *
 * Two-phase lifecycle mapped onto Docker primitives:
 *
 * - `prewarm` runs the base image, applies base setup, runs the
 *   authored preparation, writes seed files, then `docker commit`s the
 *   container into a reusable template image.
 * - `create` starts (or restarts) one long-lived container per session
 *   key from the template image. The container's filesystem carries
 *   session state across reconnects, so `shutdown` only stops the
 *   container and the next `create` restarts it with state intact.
 */
export function createDockerSandboxEngine(
  input: CreateDockerSandboxEngineInput = {},
): SandboxEngine {
  const cli = input.dockerCli ?? createDockerCli();
  const options = resolveDockerSandboxOptions(input.createOptions);
  const configuration = parseJsonObject(input.createOptions ?? {});
  const optionsHash = createDockerSandboxOptionsHash(options);
  let daemonCheck: Promise<void> | undefined;

  function ensureDaemon(): Promise<void> {
    daemonCheck ??= assertDockerDaemonAvailable(cli).catch((error: unknown) => {
      daemonCheck = undefined;
      throw error;
    });
    return daemonCheck;
  }

  return {
    provider: DOCKER_PROVIDER,
    async prepare(prewarmInput: SandboxEnginePrepareInput): Promise<SandboxEnginePrepareResult> {
      prewarmInput.log?.("checking Docker daemon");
      await ensureDaemon();
      const templateReferenceInput = {
        optionsHash,
        templateKey: prewarmInput.templateKey,
      };
      const imageReference = dockerTemplateImageReference(templateReferenceInput);
      const markerPath = resolveDockerTemplateMarkerPath(
        prewarmInput.context.appRoot,
        templateReferenceInput,
      );

      prewarmInput.log?.(`checking cached template image "${imageReference}"`);
      if (
        options.pullPolicy !== "always" &&
        isImmutableOciImageReference(options.image) &&
        (await dockerImageExists(cli, imageReference))
      ) {
        prewarmInput.log?.("reusing cached template image");
        await touchDockerTemplateMarker(markerPath, imageReference);
        return { reused: true };
      }

      prewarmInput.log?.(`checking base image "${options.image}"`);
      await ensureDockerBaseImage(cli, options);

      const buildContainerName = `${prewarmInput.templateKey}-build-${randomUUID().slice(0, 8)}`;
      prewarmInput.log?.("starting template build container");
      await startDockerContainer({
        cli,
        containerName: buildContainerName,
        image: options.image,
        initialNetworkPolicy: "allow-all",
        options,
        role: "template-build",
      });

      try {
        prewarmInput.log?.("preparing base runtime inside container");
        await runDockerBaseSetup(cli, buildContainerName);
        if (options.networkPolicy !== "allow-all") {
          prewarmInput.log?.("applying network policy");
          await setDockerNetworkPolicy(cli, buildContainerName, options.networkPolicy);
        }

        const templateSession = buildSandboxSession(
          createDockerInternalSession({
            cli,
            containerName: buildContainerName,
            id: prewarmInput.templateKey,
          }),
          (policy) => setDockerNetworkPolicy(cli, buildContainerName, policy),
        );

        if (prewarmInput.seedFiles.length > 0) {
          prewarmInput.log?.(`writing ${prewarmInput.seedFiles.length} seed file(s)`);
        }
        await writeSandboxSeedFiles(templateSession, prewarmInput.seedFiles);

        if (prewarmInput.prepare !== undefined) {
          prewarmInput.log?.("running template preparation");
          await prewarmInput.prepare(
            createLoggingSandboxSession({
              log: prewarmInput.log,
              session: templateSession,
            }),
          );
        }

        // Quiesce before commit so the captured filesystem is stable.
        prewarmInput.log?.("stopping template build container");
        expectDockerSuccess(
          await cli.run(["stop", "-t", "0", buildContainerName]),
          `stop template build container "${buildContainerName}"`,
        );
        prewarmInput.log?.(`committing template image "${imageReference}"`);
        expectDockerSuccess(
          await cli.run([
            "commit",
            "--change",
            `LABEL ${DOCKER_SANDBOX_LABEL}=1`,
            "--change",
            `LABEL ${DOCKER_SANDBOX_LABEL}.role=template`,
            "--change",
            `LABEL ${DOCKER_SANDBOX_LABEL}.template-key=${prewarmInput.templateKey}`,
            buildContainerName,
            imageReference,
          ]),
          `commit sandbox template image "${imageReference}"`,
        );
        await touchDockerTemplateMarker(markerPath, imageReference);
      } finally {
        await cli.run(["rm", "-f", buildContainerName]).catch(() => {});
      }

      return { reused: false };
    },
    async create(createInput: SandboxEngineCreateInput): Promise<SandboxEngineHandle> {
      await ensureDaemon();
      const persistedIdentity = readPersistedDockerContainerIdentity(createInput.existingMetadata);
      const containerName = persistedIdentity?.name ?? createInput.sessionKey;
      const existing = await inspectDockerContainer(cli, containerName);
      let containerId: string;

      if (existing !== null) {
        if (persistedIdentity !== undefined && existing.id !== persistedIdentity.id) {
          throw new SandboxResourceUnavailableError({
            provider: DOCKER_PROVIDER,
            sessionKey: containerName,
          });
        }
        containerId = existing.id;
        if (!existing.running) {
          expectDockerSuccess(
            await cli.run(["start", containerName]),
            `restart sandbox session container "${containerName}"`,
          );
        }
      } else {
        if (createInput.existingMetadata !== undefined) {
          throw new SandboxResourceUnavailableError({
            provider: DOCKER_PROVIDER,
            sessionKey: containerName,
          });
        }
        let image: string;
        if (createInput.templateKey === null) {
          await ensureDockerBaseImage(cli, options);
          image = options.image;
        } else {
          const templateReferenceInput = {
            optionsHash,
            templateKey: createInput.templateKey,
          };
          image = dockerTemplateImageReference(templateReferenceInput);
          if (!(await dockerImageExists(cli, image))) {
            throw new SandboxTemplateUnavailableError({
              provider: DOCKER_PROVIDER,
              templateKey: createInput.templateKey,
            });
          }
          await touchDockerTemplateMarker(
            resolveDockerTemplateMarkerPath(createInput.context.appRoot, templateReferenceInput),
            image,
          );
        }

        try {
          containerId = await startDockerContainer({
            cli,
            containerName,
            image,
            initialNetworkPolicy:
              createInput.templateKey === null ? "allow-all" : options.networkPolicy,
            options,
            role: "session",
            tags: createInput.tags,
          });
        } catch (error) {
          if (createInput.templateKey !== null) {
            throw new SandboxTemplateUnavailableError({
              provider: DOCKER_PROVIDER,
              templateKey: createInput.templateKey,
            });
          }
          throw error;
        }

        if (createInput.templateKey === null) {
          await runDockerBaseSetup(cli, containerName);
          if (options.networkPolicy !== "allow-all") {
            await setDockerNetworkPolicy(cli, containerName, options.networkPolicy);
          }
        }
      }

      const session = buildSandboxSession(
        createDockerInternalSession({ cli, containerName, id: createInput.sessionKey }),
        (policy) => setDockerNetworkPolicy(cli, containerName, policy),
      );

      return {
        session,
        async captureState() {
          return {
            configuration,
            provider: DOCKER_PROVIDER,
            metadata: { containerId, containerName },
            sessionKey: createInput.sessionKey,
          };
        },
        // Session state lives in the container filesystem, so a stopped
        // container restarts with state intact on the next `create`.
        async shutdown() {
          await stopDockerContainerIfRunning(cli, containerName);
        },
      };
    },
  };
}

function readPersistedDockerContainerIdentity(
  metadata: Record<string, unknown> | undefined,
): { readonly id: string; readonly name: string } | undefined {
  if (metadata === undefined) {
    return undefined;
  }
  if (typeof metadata.containerId !== "string" || typeof metadata.containerName !== "string") {
    throw new TypeError("Invalid persisted Docker sandbox identity.");
  }
  return {
    id: metadata.containerId,
    name: metadata.containerName,
  };
}

async function inspectDockerContainer(
  cli: DockerCli,
  containerName: string,
): Promise<{ readonly id: string; readonly running: boolean } | null> {
  const result = await cli.run([
    "container",
    "inspect",
    "--format",
    "{{.Id}} {{.State.Running}}",
    containerName,
  ]);
  if (result.exitCode !== 0) {
    return null;
  }
  const match = /^(\S+) (true|false)$/.exec(result.stdout.trim());
  if (match === null) {
    throw new Error(`Docker returned invalid identity for sandbox container "${containerName}".`);
  }
  return {
    id: match[1]!,
    running: match[2] === "true",
  };
}

function isImmutableOciImageReference(image: string): boolean {
  return /@sha256:[a-f0-9]{64}$/i.test(image);
}
