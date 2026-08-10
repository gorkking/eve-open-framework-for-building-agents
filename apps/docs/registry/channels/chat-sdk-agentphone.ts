import { createAgentPhoneAdapter } from "@agentphone/chat-sdk-adapter";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { Message, Thread } from "chat";
import { chatSdkChannel } from "eve/channels/chat-sdk";

export const { bot, channel, send } = chatSdkChannel({
  userName: "My Agent",
  adapters: {
    agentphone: createAgentPhoneAdapter({
      apiKey: process.env.AGENTPHONE_API_KEY!,
      agentId: process.env.AGENTPHONE_AGENT_ID!,
      webhookSecret: process.env.AGENTPHONE_WEBHOOK_SECRET!,
    }),
  },
  state: createMemoryState(),
  // Phone messages and voice transcripts are delivered as completed replies.
  streaming: false,
});

bot.onNewMention(async (thread: Thread, message: Message) => {
  await thread.subscribe();
  await send(message.text, { thread });
});

bot.onSubscribedMessage(async (thread: Thread, message: Message) => {
  await send(message.text, { thread });
});

export default channel;
