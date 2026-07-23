import { configurePhotonWebhook } from "./boxes/configure-photon-webhook.js";
import type { ChannelSetupIntegration } from "./channel-setup-integration.js";
import { runChannelSetup } from "./channel-setup-runner.js";
import { runInteractive } from "./runner.js";
import { snapshotSetupState } from "./state.js";
import type { OutputSink } from "./step.js";

/** iMessage's Photon provisioning, scaffold, and webhook configuration behavior. */
export const IMESSAGE_CHANNEL_SETUP: ChannelSetupIntegration = {
  kind: "imessage",
  label: "iMessage",
  hint: "Messages through Photon",
  async setup(context) {
    const scaffolded = await runChannelSetup(context, {});
    if (scaffolded.kind === "cancelled") return scaffolded;

    const deps = context.deps;
    const box = configurePhotonWebhook({
      asker: context.ui.asker,
      prompter: context.ui.prompter,
      ...(deps === undefined
        ? {}
        : {
            deps: {
              runVercel: deps.runVercel,
              ...(deps.readProjectLink === undefined
                ? {}
                : { readProjectLink: deps.readProjectLink }),
            },
          }),
    });
    const sink: OutputSink = { write: (line) => context.ui.prompter.log.message(line) };
    const configured = await runInteractive([box], scaffolded.state, sink, {
      snapshot: snapshotSetupState,
      signal: context.signal,
    });
    return configured.kind === "done"
      ? { kind: "done", state: configured.state }
      : { kind: "cancelled" };
  },
};
