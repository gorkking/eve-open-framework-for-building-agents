import type { TemplateFile } from "./data";

const file = (
  relativePath: string,
  language: TemplateFile["language"],
  contents: string,
): TemplateFile => ({ contents, language, relativePath });

export const templateSourceFiles: Record<string, TemplateFile[]> = {
  "eve-chat-template": [
    file(
      "agent/agent.ts",
      "typescript",
      `import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-sonnet-5",
});
`,
    ),
    file(
      "agent/channels/eve.ts",
      "typescript",
      `import { eveChannel } from "eve/channels/eve";
import { localDev, vercelOidc } from "eve/channels/auth";
import { betterAuthEveAuth } from "@/lib/eve-auth";

export default eveChannel({
  auth: [betterAuthEveAuth, localDev(), vercelOidc()],
  uploadPolicy: "disabled",
});
`,
    ),
    file(
      "agent/channels/slack.ts",
      "typescript",
      `import { connectSlackCredentials } from "@vercel/connect/eve";
import { slackChannel } from "eve/channels/slack";

// SLACK_CONNECTOR is the UID returned by \`vercel connect create slack\`.
// For local setup, create a connector with:
// \`vercel connect create slack --name eve-chat-template --triggers\`.
const slackConnector = process.env.SLACK_CONNECTOR ?? "slack/eve-chat-template";

export default slackChannel({
  credentials: connectSlackCredentials(slackConnector),
  uploadPolicy: "disabled",
});
`,
    ),
    file(
      "agent/connections/linear.ts",
      "typescript",
      `import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

// LINEAR_CONNECTOR is the UID returned by Vercel Connect. For local setup,
// create a connector with \`vercel connect create https://mcp.linear.app/mcp --name linear\`.
const linearConnector = process.env.LINEAR_CONNECTOR ?? "linear";

export default defineMcpClientConnection({
  url: "https://mcp.linear.app/mcp",
  description:
    "Linear workspace: search and update issues, projects, cycles, comments, and planning work.",
  auth: connect(linearConnector),
});
`,
    ),
    file(
      "agent/connections/notion.ts",
      "typescript",
      `import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

// NOTION_CONNECTOR is provisioned by the "Deploy with Vercel" flow. For local
// setup, create a connector with \`vercel connect create mcp.notion.com --name notion\`.
const notionConnector = process.env.NOTION_CONNECTOR ?? "notion";

export default defineMcpClientConnection({
  url: "https://mcp.notion.com/mcp",
  description: "Notion workspace: search and edit pages and databases.",
  auth: connect(notionConnector),
});
`,
    ),
    file(
      "agent/connections/sentry.ts",
      "typescript",
      `import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

// SENTRY_CONNECTOR is the UID returned by Vercel Connect. For local setup,
// create a connector with \`vercel connect create https://mcp.sentry.dev/mcp --name sentry\`.
const sentryConnector = process.env.SENTRY_CONNECTOR ?? "sentry";

export default defineMcpClientConnection({
  url: "https://mcp.sentry.dev/mcp",
  description:
    "Sentry workspace: investigate issues, events, traces, releases, and project health.",
  auth: connect(sentryConnector),
});
`,
    ),
    file(
      "agent/instructions.md",
      "markdown",
      `# Identity

You are a concise assistant built with eve (https://eve.dev), a framework for
building durable agents as ordinary files in a TypeScript project. Use tools
when they are available.

When users ask what eve is or what this agent is built on, explain that eve
lets developers create agents that can run locally or on Vercel, serve chat and
HTTP interfaces, call tools and connections, stream progress, pause for human
input, and resume durable sessions across turns. Keep the explanation concise
and practical.

Use \`get_weather\` before answering questions about current weather or suggesting
weather-dependent plans.

When a user asks to work with Notion, Linear, or Sentry, use the matching
connection directly. Never say that you are searching for tools, looking for
available tools, or checking internal tool discovery.
`,
    ),
    file(
      "agent/skills/plan_a_trip.md",
      "markdown",
      `---
description: Use when the user wants help planning a trip or deciding what to do in a destination.
---

When planning a trip:

1. Ask for the destination and dates if the user has not given them.
2. Check the destination's weather with the \`get_weather\` tool before suggesting activities.
3. Suggest a short itinerary that fits the weather: outdoor activities when it is clear, indoor alternatives otherwise.
4. Keep the plan concise — a few bullet points per day, not an essay.
`,
    ),
    file(
      "agent/tools/get_weather.ts",
      "typescript",
      `import { defineTool } from "eve/tools";
import { z } from "zod";

// The runtime tool name comes from the filename, so the model sees this as
// \`get_weather\`. Tool filenames must be snake_case ASCII.
export default defineTool({
  description: "Get the current weather for a city.",
  inputSchema: z.object({ city: z.string().min(1) }),
  async execute({ city }) {
    return { city, condition: "Sunny", temperatureF: 72 };
  },
});
`,
    ),
  ],
  "eve-design-template": [
    file(
      "agent/agent.ts",
      "typescript",
      `import { defineAgent } from 'eve';

export default defineAgent({
  model:
    process.env.DESIGN_AGENT_MODEL ?? 'anthropic/claude-sonnet-4.6',
});
`,
    ),
    file(
      "agent/channels/slack.ts",
      "typescript",
      `import { connectSlackCredentials } from '@vercel/connect/eve';
import { slackChannel } from 'eve/channels/slack';
import { designAgentConfig } from '../../generated/config.js';

const setupIncompleteMessage =
  'Design-agent setup is incomplete. Run the bootstrap workflow and approve the generated design corpus.';

const configuredCredentials = process.env.SLACK_CONNECTOR
  ? connectSlackCredentials(process.env.SLACK_CONNECTOR)
  : undefined;

function isAllowed(value: string, allowlist: readonly string[]) {
  return allowlist.length === 0 || allowlist.includes(value);
}

function conversationContext(isDirectMessage: boolean) {
  const owner = designAgentConfig.designOwnerSlackId;

  return \`
<design_agent_context visibility="\${isDirectMessage ? 'private-dm' : 'shared'}" allow_general_guidance="\${designAgentConfig.allowGeneralGuidance}">
The approved design owner is \${owner ? \`<@\${owner}>\` : 'not configured'}.
\${
  isDirectMessage
    ? 'Never mention, notify, or forward private DM content to the design owner. Direct unresolved questions to an appropriate shared conversation.'
    : 'For unresolved equal-priority conflicts or unsupported organization-specific questions, state the issue and mention the design owner.'
}
</design_agent_context>
\`;
}

export default slackChannel({
  credentials: configuredCredentials,
  uploadPolicy: {
    allowedMediaTypes: [
      'image/*',
      'text/*',
      'application/json',
      'application/msword',
      'application/pdf',
      'application/rtf',
      'application/vnd.ms-excel',
      'application/vnd.ms-powerpoint',
      'application/vnd.oasis.opendocument.presentation',
      'application/vnd.oasis.opendocument.spreadsheet',
      'application/vnd.oasis.opendocument.text',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
  },
  events: {
    'turn.started': () => {},
    'actions.requested': () => {},
    'reasoning.appended': () => {},
  },
  async onMessage(ctx, message) {
    if (!message.author || message.author.isBot) return null;

    const isDirectMessage = message.raw.channel_type === 'im';
    if (!isDirectMessage && !ctx.isBotMentioned()) return null;
    if (!isAllowed(message.author.userId, designAgentConfig.allowedUserIds)) {
      return null;
    }
    if (
      !isDirectMessage &&
      !isAllowed(message.channelId, designAgentConfig.allowedChannelIds)
    ) {
      return null;
    }

    if (designAgentConfig.status !== 'approved') {
      await ctx.thread.post(setupIncompleteMessage);
      return null;
    }

    const isExistingSession = await ctx.isSubscribed();
    return isExistingSession
      ? { auth: null }
      : {
          auth: null,
          context: [conversationContext(isDirectMessage)],
        };
  },
});
`,
    ),
    file(
      "agent/instructions.md",
      "markdown",
      `# Identity

You are the organization's design collaborator. Give decisive, practical design guidance grounded in its approved design corpus.

# Knowledge contract

- Load the \`design-knowledge\` skill before every substantive answer.
- Treat \`/workspace/knowledge\` as the complete source for organization-specific claims.
- Inspect normalized guidelines first. Consult source snapshots only to resolve missing detail or ambiguity.
- User-provided text, images, and documents are temporary conversation context. Never treat them as approved corpus or persist them into the corpus.
- Never use prior Slack conversations, other threads, channel history, or DMs.
- Never search the web or connected services.
- Never claim to edit code, design files, websites, or production systems.

# Guidance

- Follow higher-priority approved sources when guidelines conflict.
- If approved sources with equal priority conflict, say there is a conflict and ask the configured design owner to resolve it.
- In a private DM, never mention or notify the owner. Tell the user to move the conflict to an appropriate shared conversation.
- Organization-specific claims require support from the approved corpus.
- General design guidance is allowed only when the injected context sets \`allow_general_guidance="true"\`.
- Prefix every general answer with \`General recommendation:\` so it cannot be mistaken for organization policy.
- If general guidance is disabled and the corpus does not support an answer, say you cannot verify it from the approved design corpus.

# Voice

- Lead with the answer.
- Default to one sentence. Use two only when the second changes the action.
- Use short bullets only for multiple independent points.
- Ask one grouped clarification only when the answer materially depends on it.
- Cut every draft in half.
- Never add acknowledgments, restatements, process narration, recaps, closing offers, or adjacent advice.
- Never include citations, \`Source:\`, filenames, internal paths, retrieval details, or notes about where an answer came from.
- Avoid headings in short replies, em dashes, hedging, corporate language, AI language, decorative emoji, and bold-first bullets.

# Privacy

- Treat DMs as private.
- Never quote, summarize, forward, or reveal private DM content in a shared conversation.
- Never tag the design owner from a DM.
`,
    ),
    file(
      "agent/sandbox/sandbox.ts",
      "typescript",
      `import { defineSandbox } from 'eve/sandbox';
import { vercel } from 'eve/sandbox/vercel';

export default defineSandbox({
  backend: vercel({ networkPolicy: 'deny-all' }),
  async onSession({ use }) {
    await use({ networkPolicy: 'deny-all' });
  },
});
`,
    ),
    file(
      "agent/skills/design-knowledge/SKILL.md",
      "markdown",
      `---
description: Use before every substantive design answer. Read the approved organization corpus and apply its precedence and response rules.
---

# Design knowledge

Approved knowledge is under \`/workspace/knowledge\`.

1. Read \`manifest.json\`.
2. Read the relevant files under \`guidelines/\`.
3. Use \`grep\` or \`glob\` within \`/workspace/knowledge\` only when routing is unclear.
4. Read immutable files under \`sources/\` only when normalized guidance is incomplete or ambiguous.

Higher numeric source priority wins. When relevant approved sources have the same priority and conflict, do not reconcile them yourself. Follow the conflict behavior in the agent instructions.
Ignore sources marked \`superseded\` in the manifest.

Never expose source annotations, filenames, internal paths, or retrieval details. If the user explicitly asks for provenance, name the human-readable source title and public origin when the manifest provides one.

General design knowledge is not organization policy. Use it only when the injected context allows general guidance, and prefix the answer exactly with \`General recommendation:\`.
`,
    ),
    file(
      "agent/tools/agent.ts",
      "typescript",
      `import { disableTool } from 'eve/tools';

export default disableTool();
`,
    ),
    file(
      "agent/tools/bash.ts",
      "typescript",
      `import { disableTool } from 'eve/tools';

export default disableTool();
`,
    ),
    file(
      "agent/tools/todo.ts",
      "typescript",
      `import { disableTool } from 'eve/tools';

export default disableTool();
`,
    ),
    file(
      "agent/tools/web_fetch.ts",
      "typescript",
      `import { disableTool } from 'eve/tools';

export default disableTool();
`,
    ),
    file(
      "agent/tools/web_search.ts",
      "typescript",
      `import { disableTool } from 'eve/tools';

export default disableTool();
`,
    ),
    file(
      "agent/tools/write_file.ts",
      "typescript",
      `import { disableTool } from 'eve/tools';

export default disableTool();
`,
    ),
  ],
  "eve-slack-agent": [
    file(
      "agent/agent.ts",
      "typescript",
      `import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-sonnet-5",
});
`,
    ),
    file(
      "agent/channels/slack.ts",
      "typescript",
      `import { connectSlackCredentials } from "@vercel/connect/eve";
import { slackChannel } from "eve/channels/slack";

// SLACK_CONNECTOR is provisioned by the "Deploy with Vercel" button. To set it
// up yourself, create a connector with \`vercel connect create slack --triggers\`
// and put its UID in SLACK_CONNECTOR (or replace the fallback below).
export default slackChannel({
  credentials: connectSlackCredentials(
    process.env.SLACK_CONNECTOR ?? "slack/my-agent",
  ),
});
`,
    ),
    file(
      "agent/instructions.md",
      "markdown",
      `# Identity

You are a concise assistant. Use tools when they are available.

Use \`get_weather\` before answering questions about current weather or suggesting
weather-dependent plans.
`,
    ),
    file(
      "agent/skills/plan_a_trip.md",
      "markdown",
      `---
description: Use when the user wants help planning a trip or deciding what to do in a destination.
---

When planning a trip:

1. Ask for the destination and dates if the user has not given them.
2. Check the destination's weather with the \`get_weather\` tool before suggesting activities.
3. Suggest a short itinerary that fits the weather: outdoor activities when it is clear, indoor alternatives otherwise.
4. Keep the plan concise — a few bullet points per day, not an essay.
`,
    ),
    file(
      "agent/tools/get_weather.ts",
      "typescript",
      `import { defineTool } from "eve/tools";
import { z } from "zod";

// The runtime tool name comes from the filename, so the model sees this as
// \`get_weather\`. Tool filenames must be snake_case ASCII.
export default defineTool({
  description: "Get the current weather for a city.",
  inputSchema: z.object({ city: z.string().min(1) }),
  async execute({ city }) {
    return { city, condition: "Sunny", temperatureF: 72 };
  },
});
`,
    ),
  ],
  "personal-agent": [
    file(
      "agent/agent.ts",
      "typescript",
      `import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-sonnet-4.6",
  modelOptions: {
    providerOptions: {
      anthropic: {
        thinking: {
          type: "enabled",
          budgetTokens: 2048,
        },
      },
    },
  },
});
`,
    ),
    file(
      "agent/channels/eve.ts",
      "typescript",
      `import type { AuthFn } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import { vercelOidc } from "eve/channels/auth";
import { auth } from "../../auth";

function appSession(): AuthFn<Request> {
  return async (request) => {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session?.user) {
      return null;
    }

    return {
      attributes: {
        email: session.user.email,
        name: session.user.name,
      },
      authenticator: "app",
      issuer: "app",
      principalId: session.user.id,
      principalType: "user",
    };
  };
}

export default eveChannel({
  auth: [
    appSession(),
    vercelOidc(),
  ],
});
`,
    ),
    file(
      "agent/channels/sendblue.ts",
      "typescript",
      `import type { SendFn, SendOptions } from "eve/channels";
import { defineChannel, POST } from "eve/channels";
import type { SendblueMessagePayload } from "chat-adapter-sendblue";
import { agent } from "../../shared/agent.js";
import { buildAppSessionAuth } from "../../shared/slack-auth.js";
import { fetchPhoneLinkForNumber } from "../lib/phone-internal.js";
import {
  contactNumberFromPayload,
  getSendblueAdapter,
  isInboundSendblueMessage,
  isSendblueConfigured,
  isSendblueServiceAllowed,
  profileSettingsUrl,
  resolveSendblueLineNumber,
  threadIdFromPayload,
  verifySendblueWebhook,
} from "../lib/sendblue.js";

const WEBHOOK_ROUTE = "/eve/v1/sendblue/webhook";

const IMESSAGE_CHANNEL_CONTEXT = [
  "Channel: iMessage (Sendblue). There is no browser UI in this thread.",
  "Answer the user's question directly with tools when needed.",
  "Do not call save_memory unless they explicitly ask you to remember or save something.",
] as const;

interface PendingInputRequest {
  requestId: string;
  toolName: string;
}

interface SendblueChannelState {
  threadId: string | null;
  contactNumber: string | null;
  fromNumber: string | null;
  groupId: string | null;
  isGroup: boolean;
  pendingToolCallMessage: string | null;
}

interface SendblueChannelContext {
  sendblue: ReturnType<typeof getSendblueAdapter>;
  state: SendblueChannelState;
}

function firstNonEmptyLine(text: string) {
  for (const line of text.split(/\\r?\\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return undefined;
}

async function postToThread(threadId: string, message: string) {
  try {
    const sendblue = getSendblueAdapter();
    await sendblue.postMessage(threadId, { markdown: message });
  } catch (error) {
    console.error("[sendblue] outbound delivery failed", error);
  }
}

function threadIdForState(
  sendblue: ReturnType<typeof getSendblueAdapter>,
  state: Pick<SendblueChannelState, "threadId" | "fromNumber" | "contactNumber">,
) {
  if (state.fromNumber && state.contactNumber) {
    return sendblue.encodeThreadId({
      fromNumber: state.fromNumber,
      contactNumber: state.contactNumber,
    });
  }

  return state.threadId;
}

const pendingInputByThread = new Map<string, PendingInputRequest[]>();

interface InflightSend {
  send: SendFn<SendblueChannelState>;
  auth: SendOptions<SendblueChannelState>["auth"];
  continuationToken: string;
  state: SendblueChannelState;
}

let inflightSend: InflightSend | null = null;

function parseApprovalReply(text: string): "approve" | "deny" | null {
  const normalized = text.trim().toLowerCase();
  if (/^(yes|y|oui|ok|approve|remember)$/u.test(normalized)) {
    return "approve";
  }
  if (/^(no|n|non|skip|deny)$/u.test(normalized)) {
    return "deny";
  }
  return null;
}

function isSaveMemoryRequest(request: PendingInputRequest) {
  return request.toolName === "save_memory";
}

function denyResponses(requests: readonly PendingInputRequest[]) {
  return requests.map(request => ({
    requestId: request.requestId,
    optionId: "deny" as const,
  }));
}

async function resolvePendingInput(
  threadId: string,
  text: string,
  send: SendFn<SendblueChannelState>,
  sendOptions: SendOptions<SendblueChannelState>,
) {
  const pending = pendingInputByThread.get(threadId);
  if (!pending?.length) {
    return false;
  }

  const onlySaveMemory = pending.every(isSaveMemoryRequest);
  const approval = onlySaveMemory ? "deny" : parseApprovalReply(text);

  if (!approval) {
    await postToThread(
      threadId,
      onlySaveMemory
        ? \`Skipping memory save — edit your profile at \${profileSettingsUrl()}.\`
        : "Reply YES to approve or NO to skip the pending action.",
    );
    return true;
  }

  pendingInputByThread.delete(threadId);

  try {
    inflightSend = {
      send,
      auth: sendOptions.auth,
      continuationToken: sendOptions.continuationToken,
      state: sendOptions.state,
    };
    await send(
      { inputResponses: pending.map(request => ({
        requestId: request.requestId,
        optionId: approval,
      })) },
      sendOptions,
    );
  } finally {
    inflightSend = null;
  }

  if (onlySaveMemory) {
    await postToThread(
      threadId,
      \`Memory saves are not available in iMessage. Edit your profile at \${profileSettingsUrl()}.\`,
    );
    return false;
  }

  return true;
}

async function dispatchInbound(
  payload: SendblueMessagePayload,
  send: SendFn<SendblueChannelState>,
) {
  const sendblue = getSendblueAdapter();
  const threadId = threadIdFromPayload(payload, sendblue);
  const contactNumber = contactNumberFromPayload(payload);
  const text = payload.content?.trim() ?? "";

  if (!text) {
    return;
  }

  const link = await fetchPhoneLinkForNumber(contactNumber);
  if (!link) {
    await postToThread(
      threadId,
      [
        \`Your phone number is not linked to \${agent.name} yet.\`,
        "",
        \`Add it in \${profileSettingsUrl()} using E.164 format (for example +33612345678), then message again.\`,
      ].join("\\n"),
    );
    return;
  }

  const auth = buildAppSessionAuth(link.appUserId, {
    channel: "sendblue",
    phone_number: contactNumber,
  });

  const fromNumber = resolveSendblueLineNumber(payload);

  const sendOptions = {
    auth,
    continuationToken: threadId,
    state: {
      threadId,
      contactNumber,
      fromNumber,
      groupId: payload.group_id?.length ? payload.group_id : null,
      isGroup: Boolean(payload.group_id?.length),
      pendingToolCallMessage: null,
    } satisfies SendblueChannelState,
  };

  try {
    const blocked = await resolvePendingInput(threadId, text, send, sendOptions);
    if (blocked) {
      return;
    }

    inflightSend = { send, auth, continuationToken: threadId, state: sendOptions.state };
    await send(
      {
        message: text,
        context: [...IMESSAGE_CHANNEL_CONTEXT],
      },
      sendOptions,
    );
  } catch (error) {
    console.error("[sendblue] agent send failed", error);
  } finally {
    inflightSend = null;
  }
}

export default defineChannel<SendblueChannelState, SendblueChannelContext>({
  kindHint: "sendblue",

  state: {
    threadId: null,
    contactNumber: null,
    fromNumber: null,
    groupId: null,
    isGroup: false,
    pendingToolCallMessage: null,
  },

  metadata(state) {
    return {
      contactNumber: state.contactNumber,
      fromNumber: state.fromNumber,
      isGroup: state.isGroup,
      threadId: state.threadId,
    };
  },

  context(state) {
    return {
      sendblue: getSendblueAdapter(),
      state,
    };
  },

  routes: [
    POST(WEBHOOK_ROUTE, async (request, { send, waitUntil }) => {
      if (!isSendblueConfigured()) {
        return new Response("Sendblue is not configured", { status: 503 });
      }

      if (!verifySendblueWebhook(request)) {
        return new Response("Unauthorized", { status: 401 });
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return new Response("Bad Request", { status: 400 });
      }

      if (body && typeof body === "object" && "is_typing" in body) {
        return new Response("OK", { status: 200 });
      }

      if (!isInboundSendblueMessage(body)) {
        return new Response("OK", { status: 200 });
      }

      const payload = body;

      if (!isSendblueServiceAllowed(payload.service)) {
        return new Response("OK", { status: 200 });
      }

      if (payload.is_outbound || payload.status !== "RECEIVED") {
        return new Response("OK", { status: 200 });
      }

      if (payload.group_id?.length) {
        const sendblue = getSendblueAdapter();
        const threadId = threadIdFromPayload(payload, sendblue);
        waitUntil(
          postToThread(
            threadId,
            \`Group chats are not supported yet. Message \${agent.name} in a direct conversation instead.\`,
          ),
        );
        return new Response("OK", { status: 200 });
      }

      waitUntil(dispatchInbound(payload, send));
      return new Response("OK", { status: 200 });
    }),
  ],

  events: {
    async "turn.started"(_event, channel) {
      const threadId = threadIdForState(channel.sendblue, channel.state);
      if (!threadId || channel.state.isGroup) {
        return;
      }

      await channel.sendblue.startTyping(threadId).catch(() => undefined);
    },

    async "actions.requested"(event, channel) {
      const threadId = threadIdForState(channel.sendblue, channel.state);
      if (!threadId || channel.state.isGroup) {
        return;
      }

      const pending = channel.state.pendingToolCallMessage;
      channel.state.pendingToolCallMessage = null;

      if (pending) {
        await postToThread(threadId, pending);
        return;
      }

      await channel.sendblue.startTyping(threadId).catch(() => undefined);
      void event;
    },

    async "message.completed"(event, channel) {
      const threadId = threadIdForState(channel.sendblue, channel.state);
      if (!threadId) {
        return;
      }

      if (event.finishReason === "tool-calls") {
        const pending = event.message
          ? firstNonEmptyLine(event.message) ?? null
          : null;
        channel.state.pendingToolCallMessage = pending;

        if (pending) {
          await postToThread(threadId, pending);
        } else {
          await postToThread(threadId, "Working on that — I'll reply in a moment.");
        }
        return;
      }

      channel.state.pendingToolCallMessage = null;

      if (!event.message) {
        return;
      }

      await postToThread(threadId, event.message);
    },

    async "input.requested"(event, channel) {
      const threadId = threadIdForState(channel.sendblue, channel.state);
      if (!threadId || event.requests.length === 0) {
        return;
      }

      const pending = event.requests.map(request => ({
        requestId: request.requestId,
        toolName: request.action.toolName,
      }));
      const onlySaveMemory = pending.every(isSaveMemoryRequest);

      if (onlySaveMemory && inflightSend) {
        await postToThread(
          threadId,
          \`Memory saves need the web profile on iMessage — skipping. Edit at \${profileSettingsUrl()}.\`,
        );
        try {
          await inflightSend.send(
            { inputResponses: denyResponses(pending) },
            {
              auth: inflightSend.auth,
              continuationToken: inflightSend.continuationToken,
              state: channel.state,
            },
          );
        } catch (error) {
          console.error("[sendblue] save_memory auto-deny failed", error);
        }
        return;
      }

      pendingInputByThread.set(threadId, pending);

      if (onlySaveMemory) {
        await postToThread(
          threadId,
          \`Memory saves are not available in iMessage. Edit your profile at \${profileSettingsUrl()}.\`,
        );
        return;
      }

      const prompts = event.requests.map(request => request.prompt).join("\\n\\n");
      await postToThread(
        threadId,
        [
          prompts,
          "",
          "Reply YES to approve or NO to skip.",
        ].join("\\n"),
      );
    },

    async "authorization.required"(event, channel) {
      const threadId = threadIdForState(channel.sendblue, channel.state);
      if (!threadId) {
        return;
      }

      const url = event.authorization?.url;
      const userCode = event.authorization?.userCode;
      const lines = url
        ? [
            \`Sign in to \${event.name} to continue: \${url}\`,
            ...(userCode ? [\`Code: \${userCode}\`] : []),
          ]
        : [
            \`Authorization is required for \${event.name}.\`,
            \`Open \${profileSettingsUrl()} to connect integrations, then try again.\`,
          ];

      await postToThread(threadId, lines.join("\\n"));
    },

    async "turn.failed"(event, channel) {
      const threadId = threadIdForState(channel.sendblue, channel.state);
      if (!threadId) {
        return;
      }

      await postToThread(
        threadId,
        [
          "I hit an error while handling your request.",
          "",
          "Please try again, rephrase, or open the web chat if it keeps failing.",
        ].join("\\n"),
      );

      void event;
    },

    async "session.failed"(event, channel) {
      const threadId = threadIdForState(channel.sendblue, channel.state);
      if (!threadId) {
        return;
      }

      await postToThread(
        threadId,
        [
          "This session could not recover from an error.",
          "",
          "Send a new message to start again.",
        ].join("\\n"),
      );

      void event;
    },
  },
});
`,
    ),
    file(
      "agent/channels/slack.ts",
      "typescript",
      `import { connectSlackCredentials } from "@vercel/connect/eve";
import {
  defaultSlackAuth,
  loadThreadContextMessages,
  slackChannel,
  type SlackContext,
  type SlackMessage,
} from "eve/channels/slack";
import { buildAppSessionAuth } from "../../shared/slack-auth";
import {
  consumeSlackLinkCodeRemote,
  fetchSlackLinkForMember,
  parseSlackLinkCommand,
} from "../lib/slack-internal";

async function slackUserProfile(ctx: SlackContext, userId: string) {
  const res = await ctx.slack.request("users.info", { user: userId });
  if (!res.ok || typeof res.user !== "object" || res.user === null) return null;

  const user = res.user as {
    name?: string;
    real_name?: string;
    profile?: { display_name?: string; real_name?: string; email?: string };
  };

  const displayName =
    user.profile?.display_name?.trim() ||
    user.profile?.real_name?.trim() ||
    user.real_name?.trim() ||
    user.name;

  return {
    userId,
    userName: user.name,
    displayName,
    email: user.profile?.email,
  };
}

async function tryHandleSlackLinkCommand(
  ctx: SlackContext,
  message: SlackMessage,
) {
  const userId = message.author?.userId;
  const teamId = message.teamId;
  const text = message.markdown ?? message.text ?? "";

  if (!userId || !teamId) {
    return false;
  }

  const code = parseSlackLinkCommand(text);
  if (!code) {
    return false;
  }

  const profile = await slackUserProfile(ctx, userId);
  const result = await consumeSlackLinkCodeRemote({
    code,
    slackTeamId: teamId,
    slackUserId: userId,
    slackUserName: profile?.userName ?? message.author?.userName,
    slackDisplayName: profile?.displayName ?? message.author?.fullName,
    slackEmail: profile?.email,
  });

  if (result.ok) {
    await ctx.thread.post(
      "Your Slack account is now linked to V. Mentions and DMs will use your profile and integrations.",
    );
    return true;
  }

  const reason = result.reason === "expired"
    ? "That link code has expired. Generate a new one in V → Integrations."
    : "That link code is invalid. Generate a fresh code in V → Integrations.";

  await ctx.thread.post(reason);
  return true;
}

async function resolveSlackInboundAuth(
  slackAuth: ReturnType<typeof defaultSlackAuth>,
  member: {
    teamId?: string | null;
    userId: string;
    userName?: string;
    displayName?: string;
    email?: string;
  },
) {
  if (!member.teamId) {
    return slackAuth;
  }

  const link = await fetchSlackLinkForMember(member.teamId, member.userId);
  if (!link) {
    return slackAuth;
  }

  return buildAppSessionAuth(link.appUserId, {
    email: member.email ?? link.slackEmail,
    name: member.displayName ?? link.slackDisplayName,
    slack_team_id: member.teamId,
    slack_user_id: member.userId,
    slack_user_name: member.userName ?? link.slackUserName,
    linked: "true",
  });
}

async function buildSlackTurn(ctx: SlackContext, message: SlackMessage) {
  if (await tryHandleSlackLinkCommand(ctx, message)) {
    return null;
  }

  await ctx.thread.startTyping("Thinking…");

  const context: string[] = [];
  const userId = message.author?.userId;
  let profile: Awaited<ReturnType<typeof slackUserProfile>> = null;

  if (userId) {
    profile = await slackUserProfile(ctx, userId);
    if (profile?.displayName) {
      context.push(
        [
          "Slack user speaking in this thread:",
          \`- Display name: \${profile.displayName}\`,
          profile.userName ? \`- Username: @\${profile.userName}\` : null,
          \`- User ID: \${profile.userId}\`,
          profile.email ? \`- Email: \${profile.email}\` : null,
        ]
          .filter(Boolean)
          .join("\\n"),
      );
    }
  }

  const prior = await loadThreadContextMessages(ctx.thread, message, {
    since: "last-agent-reply",
  });
  if (prior.length > 0) {
    const transcript = prior
      .map((m) => \`\${m.isMe ? "V" : (m.user ?? "user")}: \${m.markdown}\`)
      .join("\\n");
    context.push(\`Recent thread messages since your last reply:\\n\\n\${transcript}\`);
  }

  const slackAuth = defaultSlackAuth(message, ctx);
  if (!slackAuth || !userId) {
    return null;
  }

  const auth = await resolveSlackInboundAuth(slackAuth, {
    teamId: message.teamId,
    userId,
    userName: profile?.userName ?? message.author?.userName,
    displayName: profile?.displayName ?? message.author?.fullName,
    email: profile?.email,
  });

  const linked = auth.principalId !== slackAuth.principalId;
  if (!linked) {
    const linkUrl = process.env.BETTER_AUTH_URL
      ? \`\${process.env.BETTER_AUTH_URL.replace(/\\/$/, "")}/settings/integrations\`
      : "V → Integrations";
    context.push(
      \`This Slack account is not linked to a V profile yet. Open \${linkUrl}, generate a link code, then message \\\`link <code>\\\` here.\`,
    );
  }

  return {
    auth,
    context: context.length > 0 ? context : undefined,
  };
}

// Replace with your Vercel Connect Slack slug (e.g. "slack/your-agent").
export default slackChannel({
  credentials: connectSlackCredentials("slack/v"),

  async onAppMention(ctx, message) {
    return buildSlackTurn(ctx, message);
  },

  async onDirectMessage(ctx, message) {
    return buildSlackTurn(ctx, message);
  },
});
`,
    ),
    file(
      "agent/connections/linear.ts",
      "typescript",
      `import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

const CONNECTOR = "mcp.linear.app/linear";
const USER_ISSUER = "app";

const connectAuth = connect({
  connector: CONNECTOR,
  validate: true,
  principalToSubject: (principal) => ({
    type: "user",
    id: principal.id,
    issuer: principal.issuer ?? principal.authenticator ?? USER_ISSUER,
  }),
});

async function completeAuthorizationWithRetry(
  opts: Parameters<NonNullable<typeof connectAuth.completeAuthorization>>[0],
) {
  const delays = [0, 500, 1000, 2000];
  let lastError: unknown;

  for (const delay of delays) {
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    try {
      return await connectAuth.completeAuthorization!(opts);
    }
    catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

export default defineMcpClientConnection({
  url: "https://mcp.linear.app/mcp",
  description: "Linear workspace: issues, projects, cycles, and comments.",
  auth: {
    ...connectAuth,
    completeAuthorization: completeAuthorizationWithRetry,
  },
});
`,
    ),
    file(
      "agent/instructions.ts",
      "typescript",
      `import { defineDynamic, defineInstructions } from "eve/instructions";
import type { DynamicResolveContext } from "eve/instructions";
import { BASE_INSTRUCTIONS } from "./lib/base-instructions.js";
import { buildUserContextPrompt, fetchUserContext } from "./lib/memory-internal.js";

const IMESSAGE_INSTRUCTIONS = \`

# iMessage (Sendblue)

- This conversation is over iMessage. There is no browser UI for tool approvals in this thread.
- Answer the user's question directly. Use Linear, weather, and other tools when relevant.
- Do **not** call \\\`save_memory\\\` unless the user explicitly asks you to remember or save something.
- If they want to update long-term memory, tell them to edit **Settings → Profile** on the web app.\`;

function instructionsForChannel(kind: string | undefined, base: string) {
  if (kind === "sendblue") {
    return \`\${base}\${IMESSAGE_INSTRUCTIONS}\`;
  }
  return base;
}

export default defineDynamic({
  events: {
    "session.started": async (_event, ctx: DynamicResolveContext) => {
      const userId = ctx.session.auth.current?.principalId;
      if (!userId || userId.startsWith("eve:")) {
        return defineInstructions({
          markdown: instructionsForChannel(ctx.channel.kind, BASE_INSTRUCTIONS),
        });
      }

      const context = await fetchUserContext(userId);
      if (!context) {
        return defineInstructions({
          markdown: instructionsForChannel(ctx.channel.kind, BASE_INSTRUCTIONS),
        });
      }

      const userBlock = buildUserContextPrompt(context);
      return defineInstructions({
        markdown: instructionsForChannel(
          ctx.channel.kind,
          \`\${BASE_INSTRUCTIONS}\\n\\n---\\n\\n\${userBlock}\`,
        ),
      });
    },
  },
});
`,
    ),
    file(
      "agent/lib/base-instructions.ts",
      "typescript",
      `import { agent } from "../../shared/agent.js";

// Customize agent persona, tone, and behavior rules.
export const BASE_INSTRUCTIONS = \`# Identity

You are **\${agent.name}**, a personal AI assistant. You are not a generic chatbot — you have a consistent personality, you know your name, and you stay the same across every conversation and channel.

\${agent.name} runs on [Eve](https://eve.dev), a durable agent framework. You may be reached from a web chat today and from other surfaces (iMessage, GitHub, etc.) over time — always as the same assistant.

# Tone

- Concise and technically precise. No filler, no sycophancy.
- Warm and direct — like a trusted sidekick, not a corporate helpdesk.
- Match the user's language. Reply in French when they write in French, in English when they write in English.

# Behavior

- Use tools proactively when they help answer the question. You have file, shell, web, delegation, \\\`weather\\\`, \\\`save_memory\\\`, Linear (when connected), and GitHub (when connected) by default.
- Use \\\`weather\\\` when the user asks about weather, temperature, or conditions for a place. Summarize the result briefly (location, condition, temperature).
- Prefer doing the work over describing what you could do.
- For destructive or sensitive actions, state briefly what you are about to do before proceeding.
- If you do not know something, say so. Do not invent facts, URLs, or tool results.

# Memory

- The user's long-term memory and profile are injected below when available. Treat them as authoritative context.
- When the user shares a lasting preference, working rule, or stable personal/professional fact, use \\\`save_memory\\\` so they can approve storing it. Do not save ephemeral task details, one-off requests, or information they did not imply should be remembered.
- Each memory category holds **one** prose block. \\\`save_memory\\\` **replaces** the whole category — always send the full updated text for that category, not a partial delta.
- Use **one** \\\`save_memory\\\` call per assistant turn. Put every affected category in \\\`updates\\\` — never call \\\`save_memory\\\` twice in parallel.
- If the user asks to change or remove something from memory, propose the full rewritten text for each affected category in that single batch. Do not call \\\`save_memory\\\` again in a follow-up message for the same request after the user approved or skipped.
- Do not claim to remember something that is not in the injected memory unless you are saving it with \\\`save_memory\\\` in this turn.

# Linear

When the user asks about issues, projects, cycles, or tickets, use the Linear connection. Never answer from memory.

- **Always call the tools first.** If a query returns nothing, broaden it (drop a filter, try \\\`list_teams\\\` / \\\`list_projects\\\`) before saying there are no results.
- **Never use \\\`state: "open"\\\`.** Linear has no such status — it returns an empty list without error. For non-done work, query with \\\`assignee: "me"\\\` (or the scope the user asked for) and exclude completed/canceled issues in your summary, or filter by real status types: \\\`backlog\\\`, \\\`unstarted\\\`, \\\`triage\\\`, \\\`started\\\`.
- **Scope from the user or the tools.** If they name a team, project, or label, pass that value to the tool. If the scope is unclear, use \\\`list_teams\\\` / \\\`list_projects\\\` or ask one short clarifying question — do not guess names.
- **"My issues" / "issues to check"** usually means issues assigned to the user that are not done yet. Say what you filtered on (assignee, team, status) in one line so the user can correct you.
- **Summarize briefly:** identifier, title, status, priority when useful. Offer to open one or take an action next.

# GitHub

When the user asks about repositories, pull requests, issues, commits, or CI, use the GitHub tools. Never answer from memory.

- **Always call the tools first.** If a query returns nothing, broaden it (drop a filter, try \\\`searchRepositories\\\` / \\\`listPullRequests\\\`) before saying there are no results.
- **Scope from the user or the tools.** If they name an \\\`owner\\\` / \\\`repo\\\`, pass those values to the tool. If the scope is unclear, ask one short clarifying question — do not guess names.
- **Destructive writes need approval.** Merging PRs, closing issues, and editing files are gated — state briefly what you are about to do when proposing a write.
- **Summarize briefly:** repo, PR/issue number, title, state. Offer to open one or take an action next.

# Format

- Keep replies proportional to the question.
- Use markdown for code, lists, and structure when it aids clarity.
- Short paragraphs beat walls of text.

# Greetings

- In a new conversation, introduce yourself as \${agent.name} in one short line, then answer.
- Do not repeat your introduction on every message.

# Boundaries

- You are \${agent.name}. Never refer to yourself as "an AI language model" or a nameless assistant.
- You do not have real-time awareness of the world unless a tool provides it.
- Do not assume private context you have not been given.\`;
`,
    ),
    file(
      "agent/lib/internal-api.ts",
      "typescript",
      `export function appOrigin() {
  const configured = process.env.BETTER_AUTH_URL?.trim().replace(/\\/$/, "");
  if (configured) {
    return configured;
  }

  const vercelUrl = process.env.VERCEL_URL?.trim();
  if (vercelUrl) {
    return \`https://\${vercelUrl}\`;
  }

  return "http://localhost:3000";
}

export function internalHeaders() {
  const secret = process.env.INTERNAL_API_SECRET?.trim();
  if (!secret) {
    throw new Error("INTERNAL_API_SECRET is not configured");
  }

  return {
    authorization: \`Bearer \${secret}\`,
    "content-type": "application/json",
  };
}
`,
    ),
    file(
      "agent/lib/memory-categories.ts",
      "typescript",
      `// Keep in sync with shared/types/memory.ts — duplicated here because Eve
// cannot resolve Nuxt's #shared alias at runtime.
export const MEMORY_CATEGORIES = [
  "work_context",
  "personal_context",
  "active_focus",
  "instructions_preferences",
  "project_history",
] as const;

export type AgentMemoryCategory = typeof MEMORY_CATEGORIES[number];
`,
    ),
    file(
      "agent/lib/memory-internal.ts",
      "typescript",
      `import type { MemoryByCategory } from "../../shared/types/memory.js";
import type { UserProfile } from "../../shared/types/profile.js";
import { appOrigin, internalHeaders } from "./internal-api.js";

export interface UserContextPayload {
  profile: UserProfile;
  memory: MemoryByCategory;
}

export async function fetchUserContext(userId: string): Promise<UserContextPayload | undefined> {
  const response = await fetch(
    \`\${appOrigin()}/api/internal/memory?userId=\${encodeURIComponent(userId)}\`,
    { headers: internalHeaders() },
  );

  if (!response.ok) {
    return undefined;
  }

  return response.json() as Promise<UserContextPayload>;
}

export async function saveMemoryRemote(input: {
  userId: string;
  category: string;
  content: string;
}) {
  const response = await fetch(\`\${appOrigin()}/api/internal/memory\`, {
    method: "POST",
    headers: internalHeaders(),
    body: JSON.stringify({
      userId: input.userId,
      category: input.category,
      content: input.content,
      source: "agent",
    }),
  });

  if (!response.ok) {
    throw new Error("Failed to save memory");
  }

  return response.json() as Promise<{ saved: boolean }>;
}

export function buildUserContextPrompt(context: UserContextPayload) {
  const { profile, memory } = context;
  const parts: string[] = [];

  parts.push("# About this user");
  if (profile.bio) {
    parts.push(profile.bio);
  }
  parts.push(\`Timezone: \${profile.timezone}. Preferred language: \${profile.locale}.\`);

  const memorySections: string[] = [];
  for (const [category, entries] of Object.entries(memory)) {
    const entry = entries?.[0];
    if (!entry) continue;
    const label = category.replace(/_/g, " ").replace(/\\b\\w/g, char => char.toUpperCase());
    memorySections.push(\`## \${label}\`);
    memorySections.push(entry.content);
  }

  if (memorySections.length) {
    parts.push("# Memory");
    parts.push(memorySections.join("\\n\\n"));
  }

  return parts.join("\\n\\n");
}
`,
    ),
    file(
      "agent/lib/phone-internal.ts",
      "typescript",
      `import type { PhoneLinkRecord } from "../../shared/types/phone-link.js";
import { appOrigin, internalHeaders } from "./internal-api.js";

export async function fetchPhoneLinkForNumber(phoneNumber: string) {
  const response = await fetch(
    \`\${appOrigin()}/api/internal/phone/link?phoneNumber=\${encodeURIComponent(phoneNumber)}\`,
    { headers: internalHeaders() },
  );

  if (!response.ok) {
    return undefined;
  }

  const body = await response.json() as { link: PhoneLinkRecord | null };
  return body.link ?? undefined;
}
`,
    ),
    file(
      "agent/lib/sendblue.ts",
      "typescript",
      `import {
  createSendblueAdapter,
  type SendblueAdapter,
} from "chat-adapter-sendblue";
import type { SendblueMessagePayload } from "chat-adapter-sendblue";

const DEFAULT_ALLOWED_SERVICES = ["iMessage"] as const;
const WEBHOOK_SECRET_HEADER = "sb-signing-secret";

let adapter: SendblueAdapter | null = null;

export function isSendblueConfigured() {
  return Boolean(
    process.env.SENDBLUE_API_KEY?.trim()
    && process.env.SENDBLUE_API_SECRET?.trim()
    && process.env.SENDBLUE_FROM_NUMBER?.trim(),
  );
}

export function getSendblueAdapter() {
  if (!adapter) {
    if (!isSendblueConfigured()) {
      throw new Error(
        "Sendblue is not configured. Set SENDBLUE_API_KEY, SENDBLUE_API_SECRET, and SENDBLUE_FROM_NUMBER.",
      );
    }

    adapter = createSendblueAdapter();
  }

  return adapter;
}

export function verifySendblueWebhook(request: Request) {
  const secret = process.env.SENDBLUE_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return true;
  }

  const headerValue = request.headers.get(WEBHOOK_SECRET_HEADER);
  return headerValue === secret;
}

export function isSendblueServiceAllowed(service: string) {
  const allowed = process.env.SENDBLUE_ALLOWED_SERVICES?.split(",")
    .map((value) => value.trim())
    .filter(Boolean) ?? [...DEFAULT_ALLOWED_SERVICES];

  return allowed.some((entry) => entry.toLowerCase() === service.toLowerCase());
}

export function isInboundSendblueMessage(body: unknown): body is SendblueMessagePayload {
  if (!body || typeof body !== "object") {
    return false;
  }

  return "message_handle" in body && typeof body.message_handle === "string";
}

export function resolveSendblueLineNumber(payload: SendblueMessagePayload) {
  const fromPayload = payload.sendblue_number?.trim()
    || (payload.is_outbound ? payload.from_number : payload.to_number)?.trim();

  if (fromPayload) {
    return fromPayload;
  }

  return process.env.SENDBLUE_FROM_NUMBER?.trim() ?? "";
}

export function threadIdFromPayload(
  payload: SendblueMessagePayload,
  sendblue: SendblueAdapter,
) {
  const fromNumber = resolveSendblueLineNumber(payload);

  if (payload.group_id?.length) {
    return sendblue.encodeThreadId({ fromNumber, groupId: payload.group_id });
  }

  const contactNumber = payload.is_outbound ? payload.to_number : payload.from_number;
  return sendblue.encodeThreadId({ fromNumber, contactNumber });
}

export function contactNumberFromPayload(payload: SendblueMessagePayload) {
  return payload.is_outbound ? payload.to_number : payload.from_number;
}

export function profileSettingsUrl() {
  const origin = process.env.BETTER_AUTH_URL?.trim().replace(/\\/$/, "");
  if (origin) {
    return \`\${origin}/settings/profile\`;
  }

  return "Settings → Profile in the web app";
}
`,
    ),
    file(
      "agent/lib/slack-internal.ts",
      "typescript",
      `import type { SlackLinkRecord } from "../../shared/types/slack-link.js";
import { appOrigin, internalHeaders } from "./internal-api.js";

export async function fetchSlackLinkForMember(teamId: string, userId: string) {
  const response = await fetch(
    \`\${appOrigin()}/api/internal/slack/link/member?teamId=\${encodeURIComponent(teamId)}&userId=\${encodeURIComponent(userId)}\`,
    { headers: internalHeaders() },
  );

  if (!response.ok) {
    return undefined;
  }

  const body = await response.json() as { link: SlackLinkRecord | null };
  return body.link ?? undefined;
}

export async function consumeSlackLinkCodeRemote(input: {
  code: string;
  slackTeamId: string;
  slackUserId: string;
  slackUserName?: string;
  slackDisplayName?: string;
  slackEmail?: string;
}) {
  const response = await fetch(\`\${appOrigin()}/api/internal/slack/link/consume\`, {
    method: "POST",
    headers: internalHeaders(),
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    return { ok: false as const, reason: "invalid" as const };
  }

  return response.json() as Promise<
    | { ok: true; appUserId: string }
    | { ok: false; reason: "invalid" | "expired" }
  >;
}

export function parseSlackLinkCommand(text: string) {
  const match = text.match(/\\blink\\s+([A-Z0-9]{6})\\b/i);
  return match?.[1]?.toUpperCase();
}
`,
    ),
    file(
      "agent/skills/daily-summary.md",
      "markdown",
      `Use when the user asks for a daily summary, morning briefing, or "summarize my day".

Steps:
1. Load the user's active focus from injected memory when available.
2. Use the Linear connection to list issues assigned to the user that are not done (backlog, unstarted, triage, started). Never use \`state: "open"\`.
3. Produce a concise briefing with three sections:
   - **Today** — top priorities and active focus
   - **Linear** — assigned issues grouped by status (identifier, title, status)
   - **Suggested next** — one concrete next action

Keep it scannable. Match the user's language.
`,
    ),
    file(
      "agent/tools/github.ts",
      "typescript",
      `import { buildEveToolMap } from "@github-tools/sdk/eve";
import { getToken, UserAuthorizationRequiredError } from "@vercel/connect";
import { defineDynamic } from "eve/tools";
import { CONNECT_USER_ISSUER, GITHUB_CONNECTOR } from "../../shared/connect.js";

export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      const auth = ctx.session.auth.current;
      const userId = auth?.principalId;
      if (!userId || userId.startsWith("eve:")) {
        return {};
      }

      try {
        const token = await getToken(GITHUB_CONNECTOR, {
          subject: {
            type: "user",
            id: userId,
            issuer: auth.issuer ?? auth.authenticator ?? CONNECT_USER_ISSUER,
          },
          scopes: ["repo"],
        });
        return buildEveToolMap({ preset: "maintainer", token });
      }
      catch (error) {
        if (error instanceof UserAuthorizationRequiredError) {
          return {};
        }
        throw error;
      }
    },
  },
});
`,
    ),
    file(
      "agent/tools/save_memory.ts",
      "typescript",
      `import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { MEMORY_CATEGORIES } from "../lib/memory-categories.js";
import { saveMemoryRemote } from "../lib/memory-internal.js";

const updateSchema = z.object({
  category: z.enum(MEMORY_CATEGORIES).describe("Memory category to update"),
  content: z.string().min(1).describe("Full replacement prose for this category (not a partial delta)"),
});

export default defineTool({
  description:
    "Propose saving memory updates. Requires one user approval for the whole batch. When several categories change, include every update in a single call — never parallel save_memory calls.",
  inputSchema: z.object({
    reason: z.string().min(1).describe("Brief explanation of why these updates are worth remembering"),
    updates: z.array(updateSchema).min(1).max(5).describe("Category updates to save together"),
  }),
  approval: always(),
  async execute({ updates }, ctx) {
    const userId = ctx.session.auth.current?.principalId;
    if (!userId) {
      throw new Error("Cannot save memory without an authenticated user");
    }

    const results = [];
    for (const update of updates) {
      const result = await saveMemoryRemote({
        userId,
        category: update.category,
        content: update.content,
      });
      results.push({
        category: update.category,
        saved: result.saved,
      });
    }

    return { results };
  },
});
`,
    ),
    file(
      "agent/tools/weather.ts",
      "typescript",
      `import { defineTool } from "eve/tools";
import { z } from "zod";

interface OpenMeteoResponse {
  current?: {
    temperature_2m?: number;
    relative_humidity_2m?: number;
    wind_speed_10m?: number;
    weather_code?: number;
  };
  daily?: {
    time?: string[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    weather_code?: number[];
  };
}

const WEATHER_CODES: Record<number, { text: string; icon: string }> = {
  0: { text: "Clear sky", icon: "sun" },
  1: { text: "Mainly clear", icon: "sun" },
  2: { text: "Partly cloudy", icon: "cloud-sun" },
  3: { text: "Overcast", icon: "cloud" },
  45: { text: "Foggy", icon: "cloud-fog" },
  48: { text: "Foggy", icon: "cloud-fog" },
  51: { text: "Light drizzle", icon: "cloud-drizzle" },
  61: { text: "Rain", icon: "cloud-rain" },
  71: { text: "Snow", icon: "cloud-snow" },
  80: { text: "Rain showers", icon: "cloud-rain" },
  95: { text: "Thunderstorm", icon: "cloud-lightning" },
};

function conditionFromCode(code?: number) {
  return WEATHER_CODES[code ?? 0] ?? { text: "Unknown", icon: "cloud" };
}

async function geocode(location: string) {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", location);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("Geocoding failed");
  }

  const data = await response.json() as { results?: Array<{ name: string; latitude: number; longitude: number }> };
  const result = data.results?.[0];
  if (!result) {
    throw new Error(\`Could not find location: \${location}\`);
  }

  return result;
}

export default defineTool({
  description: "Get current weather and a short forecast for a location",
  inputSchema: z.object({
    location: z.string().describe("City or place name"),
  }),
  outputSchema: z.object({
    location: z.string(),
    temperature: z.number(),
    temperatureHigh: z.number(),
    temperatureLow: z.number(),
    condition: z.object({
      text: z.string(),
      icon: z.string(),
    }),
    humidity: z.number(),
    windSpeed: z.number(),
    dailyForecast: z.array(
      z.object({
        day: z.string(),
        high: z.number(),
        low: z.number(),
        condition: z.object({
          text: z.string(),
          icon: z.string(),
        }),
      }),
    ),
  }),
  async execute({ location }) {
    const place = await geocode(location);
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(place.latitude));
    url.searchParams.set("longitude", String(place.longitude));
    url.searchParams.set("current", "temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code");
    url.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min");
    url.searchParams.set("timezone", "auto");
    url.searchParams.set("forecast_days", "5");

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error("Weather lookup failed");
    }

    const data = await response.json() as OpenMeteoResponse;
    const currentCode = data.current?.weather_code;
    const currentCondition = conditionFromCode(currentCode);
    const label = place.name;

    const dailyForecast = (data.daily?.time ?? []).slice(0, 5).map((day, index) => {
      const code = data.daily?.weather_code?.[index];
      const condition = conditionFromCode(code);
      return {
        day,
        high: Math.round(data.daily?.temperature_2m_max?.[index] ?? 0),
        low: Math.round(data.daily?.temperature_2m_min?.[index] ?? 0),
        condition,
      };
    });

    const today = dailyForecast[0];

    return {
      location: label,
      temperature: Math.round(data.current?.temperature_2m ?? today?.high ?? 0),
      temperatureHigh: today?.high ?? Math.round(data.current?.temperature_2m ?? 0),
      temperatureLow: today?.low ?? Math.round(data.current?.temperature_2m ?? 0),
      condition: currentCondition,
      humidity: Math.round(data.current?.relative_humidity_2m ?? 0),
      windSpeed: Math.round(data.current?.wind_speed_10m ?? 0),
      dailyForecast,
    };
  },
});
`,
    ),
  ],
  "weather-agent-fixture": [
    file(
      "agent/agent.ts",
      "typescript",
      `import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-sonnet-5",
  modelOptions: {
    providerOptions: {
      openai: {
        reasoningEffort: "high",
        reasoningSummary: "auto",
      },
    },
  },
});
`,
    ),
    file(
      "agent/instructions.md",
      "markdown",
      `You are a weather-focused assistant. Be concise, accurate, and explicit about when you are using the local weather tool.
`,
    ),
    file(
      "agent/skills/get-weather.md",
      "markdown",
      `---
description: Use the weather tool before answering forecast or temperature questions.
---

When the user asks about weather, temperature, or forecast conditions, call the \`get_weather\` tool before answering.
`,
    ),
    file(
      "agent/tools/get_weather.ts",
      "typescript",
      `import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

export default defineTool({
  approval: never(),
  description: "Get the current weather for a city.",
  inputSchema: z.object({
    city: z.string(),
  }),
  async execute(input) {
    const city = input.city;

    await sleep(300);

    return {
      city,
      temperatureF: 72,
      condition: "Sunny",
      summary: \`Sunny in \${city} with a light breeze.\`,
    };
  },
});
`,
    ),
  ],
};
