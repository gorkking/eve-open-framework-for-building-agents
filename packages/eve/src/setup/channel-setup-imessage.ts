import { text } from "./ask.js";
import type { ChannelSetupIntegration } from "./channel-setup-integration.js";
import { runChannelSetup } from "./channel-setup-runner.js";
import { WizardCancelledError } from "./step.js";

interface IMessageSetupPlan {
  credentials: "vercel-connect" | "environment";
  photonProject: "create" | { projectId: string; projectSecret: string };
  photonProjectName?: string;
  webhookBaseUrl?: string;
}

async function choosePhotonProject(
  context: Parameters<ChannelSetupIntegration["setup"]>[0],
): Promise<Pick<IMessageSetupPlan, "photonProject" | "photonProjectName">> {
  const defaultName = `eve · ${context.state.agentName || "agent"}`;
  const options = [
    {
      value: "create" as const,
      label: "Create a new Photon project",
      hint: `Name: ${defaultName}`,
    },
    {
      value: "existing" as const,
      label: "Use an existing Photon project",
      hint: "Enter its project credentials",
    },
  ];
  const editable = context.ui.prompter.selectEditable
    ? await context.ui.prompter.selectEditable<"create" | "existing">({
        message: "Photon project",
        options,
        initialValue: "create",
        editable: {
          value: "create",
          defaultValue: defaultName,
          formatHint: (value) => `Name: ${value}`,
          validate: (value) =>
            value.trim().length === 0 ? "Project name cannot be empty." : undefined,
        },
      })
    : undefined;
  const source =
    editable?.value ??
    (await context.ui.prompter.select<"create" | "existing">({
      message: "Photon project",
      options,
      initialValue: "create",
    }));
  if (source === "existing") {
    const projectId = await context.ui.asker.ask(
      text({ key: "photon-project-id", message: "Photon project ID", required: true }),
    );
    const projectSecret = await context.ui.asker.ask(
      text({
        key: "photon-project-secret",
        message: "Photon project secret",
        required: true,
        sensitive: true,
      }),
    );
    return { photonProject: { projectId: projectId.trim(), projectSecret: projectSecret.trim() } };
  }

  return {
    photonProject: "create",
    photonProjectName: editable?.kind === "edited" ? editable.text.trim() : defaultName,
  };
}

async function chooseSetupPlan(
  context: Parameters<ChannelSetupIntegration["setup"]>[0],
): Promise<IMessageSetupPlan | "cancelled"> {
  try {
    const photon = await choosePhotonProject(context);
    if (context.environment.vercel.kind === "available") {
      return { credentials: "vercel-connect", ...photon };
    }
    if (context.presetPortableCredentials !== undefined) {
      if (!context.presetPortableCredentials) return { credentials: "vercel-connect", ...photon };
      throw new Error(
        "iMessage setup needs the public HTTPS URL that will receive Photon webhooks. Run `eve channels add imessage` interactively.",
      );
    }
    const destination = await context.ui.prompter.select<"vercel" | "portable">({
      message: "Where will this iMessage agent run?",
      options: [
        {
          value: "vercel",
          label: "Vercel",
          hint: "Set up Vercel Connect and deploy",
        },
        {
          value: "portable",
          label: "Another host",
          hint: "Use environment variables and your public URL",
        },
      ],
    });
    if (destination === "vercel") return { credentials: "vercel-connect", ...photon };

    const webhookBaseUrl = await context.ui.asker.ask(
      text({
        key: "imessage-webhook-base-url",
        message: "Public HTTPS URL for your deployed agent",
        placeholder: "https://agent.example.com",
        required: true,
        validate(value) {
          try {
            const url = new URL(value.trim());
            return url.protocol === "https:" && url.pathname === "/" && !url.search && !url.hash
              ? null
              : "Enter an HTTPS origin without a path, for example https://agent.example.com";
          } catch {
            return "Enter an HTTPS origin, for example https://agent.example.com";
          }
        },
      }),
    );
    return {
      credentials: "environment",
      webhookBaseUrl: webhookBaseUrl.trim().replace(/\/$/, ""),
      ...photon,
    };
  } catch (error) {
    if (error instanceof WizardCancelledError) return "cancelled";
    throw error;
  }
}

/** iMessage's managed Photon provisioning and scaffold behavior. */
export const IMESSAGE_CHANNEL_SETUP: ChannelSetupIntegration = {
  kind: "imessage",
  label: "iMessage",
  hint: "Messages through Photon",
  async setup(context) {
    const plan = await chooseSetupPlan(context);
    if (plan === "cancelled") return { kind: "cancelled" };
    const result = await runChannelSetup(
      context,
      plan.credentials === "vercel-connect"
        ? {
            imessageCredentials: "vercel-connect",
            ensureLinkedProject: "interactive-vercel-link",
            photonProject: plan.photonProject,
            photonProjectName: plan.photonProjectName,
          }
        : {
            imessageCredentials: "environment",
            imessageWebhookBaseUrl: plan.webhookBaseUrl,
            photonProject: plan.photonProject,
            photonProjectName: plan.photonProjectName,
          },
    );
    if (
      result.kind === "done" &&
      plan.credentials === "environment" &&
      result.state.channels.includes("imessage")
    ) {
      context.ui.nextSteps([
        "Copy IMESSAGE_PROJECT_ID, IMESSAGE_PROJECT_SECRET, and IMESSAGE_WEBHOOK_SECRET from .env.local into your host's encrypted environment variables.",
        "Deploy the agent at the public URL you provided. Photon is already configured to send signed webhooks to /eve/v1/imessage.",
      ]);
    }
    return result;
  },
};
