import type { Telegraf } from "telegraf";

type TelegramApi = Telegraf["telegram"];
type TelegramChatId = Parameters<TelegramApi["sendMessage"]>[0];

const DEFAULT_MESSAGE_LIMIT = 3900;

export async function sendLongTelegramMessage(
  telegram: TelegramApi,
  chatId: TelegramChatId,
  text: string,
  limit = DEFAULT_MESSAGE_LIMIT,
): Promise<void> {
  for (let i = 0; i < text.length; i += limit) {
    await telegram.sendMessage(chatId, text.slice(i, i + limit));
  }
}
