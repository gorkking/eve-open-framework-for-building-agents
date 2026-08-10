import { createXAdapter } from "@chat-adapter/x";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { Message, Thread } from "chat";
import { chatSdkChannel } from "eve/channels/chat-sdk";

export const { bot, channel, send } = chatSdkChannel({
  userName: "My Agent",
  // Set X_CONSUMER_SECRET and either X_USER_ACCESS_TOKEN or the managed OAuth
  // refresh credentials before registering the Activity API webhook.
  adapters: { x: createXAdapter() },
  state: createMemoryState(),
  // X buffers replies and posts once; public post edits are eligibility-gated.
  streaming: false,
});

bot.onNewMention(async (thread: Thread, message: Message) => {
  await thread.subscribe();
  await send(message.text, { thread });
});

bot.onDirectMessage(async (thread: Thread, message: Message) => {
  await send(message.text, { thread });
});

bot.onSubscribedMessage(async (thread: Thread, message: Message) => {
  await send(message.text, { thread });
});

export default channel;
