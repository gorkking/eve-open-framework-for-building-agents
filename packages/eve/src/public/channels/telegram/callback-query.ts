import { logChannelOperationFailure } from "#channel/log-operation-failure.js";
import { createLogger } from "#internal/logging.js";
import { defaultTelegramCallbackAuth } from "#public/channels/telegram/defaults.js";
import {
  TELEGRAM_HITL_CALLBACK_PREFIX,
  telegramCallbackInputResponse,
} from "#public/channels/telegram/hitl.js";
import type { TelegramCallbackQuery } from "#public/channels/telegram/inbound.js";
import type {
  TelegramChannelConfig,
  TelegramChannelState,
  TelegramContext,
} from "#public/channels/telegram/telegramChannel.js";
import type { SendFn } from "#public/definitions/channel.js";

const log = createLogger("telegram.channel");

/** Dispatches a Telegram callback query after the webhook has been acknowledged. */
export async function dispatchTelegramCallbackQuery(input: {
  readonly continuationToken: string;
  readonly onCallbackQuery: TelegramChannelConfig["onCallbackQuery"];
  readonly query: TelegramCallbackQuery;
  readonly send: SendFn<TelegramChannelState>;
  readonly state: TelegramChannelState;
  readonly telegram: TelegramContext;
}): Promise<void> {
  if (input.query.data?.startsWith(TELEGRAM_HITL_CALLBACK_PREFIX) === true) {
    await dispatchHitlCallback(input);
    return;
  }

  if (input.onCallbackQuery !== undefined) {
    try {
      await input.onCallbackQuery(input.telegram, input.query);
    } catch (error) {
      log.error("custom callback-query handler failed", { error });
    }
    return;
  }

  try {
    await input.telegram.telegram.answerCallbackQuery({
      callbackQueryId: input.query.id,
      text: "Unsupported action.",
    });
  } catch (error) {
    log.warn("Telegram unsupported callback-query acknowledgement failed", { error });
  }
}

async function dispatchHitlCallback(input: {
  readonly continuationToken: string;
  readonly query: TelegramCallbackQuery;
  readonly send: SendFn<TelegramChannelState>;
  readonly state: TelegramChannelState;
  readonly telegram: TelegramContext;
}): Promise<void> {
  try {
    await input.telegram.telegram.answerCallbackQuery({
      callbackQueryId: input.query.id,
      text: "Answer received.",
    });
  } catch (error) {
    log.warn("Telegram callback-query acknowledgement failed", { error });
  }

  if (!input.query.message || !input.state.chatId) return;
  try {
    await input.send(
      {
        inputResponses: [telegramCallbackInputResponse(input.query.data ?? "")],
      },
      {
        auth: defaultTelegramCallbackAuth(input.query),
        continuationToken: input.continuationToken,
        state: input.state,
      },
    );
  } catch (error) {
    logChannelOperationFailure(log, "callback query delivery failed", error);
  }
}
