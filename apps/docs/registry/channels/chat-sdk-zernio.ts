import { createZernioAdapter } from "@zernio/chat-sdk-adapter";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { Message, Thread } from "chat";
import { chatSdkChannel } from "eve/channels/chat-sdk";

export const { bot, channel, send } = chatSdkChannel({
  userName: "My Agent",
  adapters: {
    zernio: createZernioAdapter({
      apiKey: process.env.ZERNIO_API_KEY!,
      webhookSecret: process.env.ZERNIO_WEBHOOK_SECRET!,
    }),
  },
  state: createMemoryState(),
  // Most Zernio-backed networks do not support edits; post completed replies.
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
