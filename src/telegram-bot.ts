import fs from "node:fs/promises";
import path from "node:path";
import { Telegraf } from "telegraf";
import type { TelegramEmoji } from "telegraf/types";
import type { CodexClient, CodexInputItem } from "./codex-client.js";
import type { ReasoningLevel } from "./config.js";
import { TelegramFileDelivery } from "./telegram-delivery.js";
import {
  buildSafeAttachmentName,
  formatBytes,
  isImageAttachment,
  MAX_FILE_SENDS_PER_TURN,
} from "./telegram-files.js";
import type { SavedAttachment } from "./telegram-files.js";
import { extractFileSendRequests, readCompletedAgentMessage } from "./telegram-text.js";
import { TelegramTurnState } from "./telegram-turn.js";
import type { UserMessageRef } from "./telegram-turn.js";
import type { VoiceService } from "./voice.js";

type TelegramBotOptions = {
  token: string;
  allowedUserId: number;
  projectRoot: string;
  temporaryRoot: string;
  threadId: string;
  reasoningLevel: ReasoningLevel;
  supportsImageInput: boolean;
  fileSendRoots: string[];
  fileSendMaxBytes: number;
  voice: VoiceService;
  codex: CodexClient;
  onStop: () => void;
};

const REACTION_WORKING: TelegramEmoji = "👀";
const REACTION_DONE: TelegramEmoji = "👌";
const REACTION_ERROR: TelegramEmoji = "😢";
const ATTACHMENT_DIR = "attachments";
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export class TelegramBridgeBot {
  private readonly bot: Telegraf;
  private readonly fileDelivery: TelegramFileDelivery;
  private readonly turn = new TelegramTurnState();
  private typingTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: TelegramBotOptions) {
    this.bot = new Telegraf(options.token);
    this.fileDelivery = new TelegramFileDelivery({
      telegram: this.bot.telegram,
      allowedUserId: options.allowedUserId,
      temporaryRoot: options.temporaryRoot,
      fileSendRoots: options.fileSendRoots,
      fileSendMaxBytes: options.fileSendMaxBytes,
    });
    this.registerHandlers();
    this.options.codex.on("notification", (message) => {
      void this.handleCodexNotification(message as { method?: string; params?: unknown });
    });
  }

  launch(): void {
    void this.bot.launch().catch((error) => {
      console.error(`Telegram bot error: ${formatError(error)}`);
      this.options.onStop();
    });
  }

  stop(): void {
    this.stopTyping();
    this.bot.stop();
  }

  private registerHandlers(): void {
    this.bot.use(async (ctx, next) => {
      if (!this.isAllowedPrivateUser(ctx.chat?.type, ctx.from?.id)) {
        return;
      }
      await next();
    });

    this.bot.start(async (ctx) => {
      await ctx.reply(this.statusText());
    });

    this.bot.command("status", async (ctx) => {
      await ctx.reply(this.statusText());
    });

    this.bot.command("session", async (ctx) => {
      await ctx.reply(this.statusText());
    });

    this.bot.command("interrupt", async (ctx) => {
      if (!this.turn.turnId) {
        await ctx.reply("No active turn to interrupt.");
        return;
      }

      await this.options.codex.interrupt(this.options.threadId, this.turn.turnId);
      await ctx.reply("Interrupt requested.");
    });

    this.bot.command("stop", async (ctx) => {
      await ctx.reply("Stopping bridge.");
      this.options.onStop();
    });

    this.bot.on("text", async (ctx) => {
      const text = ctx.message.text.trim();
      const userMessage = {
        chatId: ctx.chat.id,
        messageId: ctx.message.message_id,
      };

      if (!text || text.startsWith("/")) {
        return;
      }

      await this.startCodexTurn(userMessage, [{ type: "text", text }], ctx.reply.bind(ctx));
    });

    this.bot.on("voice", async (ctx) => {
      const voice = ctx.message.voice;
      const userMessage = {
        chatId: ctx.chat.id,
        messageId: ctx.message.message_id,
      };

      await this.handleVoiceMessage(
        userMessage,
        ctx.reply.bind(ctx),
        voice.file_id,
        voice.mime_type,
        voice.file_size,
      );
    });

    this.bot.on("photo", async (ctx) => {
      const photo = ctx.message.photo.at(-1);
      const userMessage = {
        chatId: ctx.chat.id,
        messageId: ctx.message.message_id,
      };

      if (!photo) {
        return;
      }

      await this.handleAttachment(
        userMessage,
        ctx.reply.bind(ctx),
        photo.file_id,
        "telegram-photo.jpg",
        "image/jpeg",
        photo.file_size,
        ctx.message.caption,
      );
    });

    this.bot.on("document", async (ctx) => {
      const document = ctx.message.document;
      const userMessage = {
        chatId: ctx.chat.id,
        messageId: ctx.message.message_id,
      };

      await this.handleAttachment(
        userMessage,
        ctx.reply.bind(ctx),
        document.file_id,
        document.file_name ?? "telegram-document",
        document.mime_type,
        document.file_size,
        ctx.message.caption,
      );
    });
  }

  private async handleAttachment(
    userMessage: UserMessageRef,
    reply: (text: string) => Promise<unknown>,
    fileId: string,
    fileName: string,
    mimeType: string | undefined,
    fileSize: number | undefined,
    caption: string | undefined,
  ): Promise<void> {
    if (this.turn.isBusy) {
      await this.replyBusy(userMessage, reply);
      return;
    }

    if (fileSize && fileSize > MAX_ATTACHMENT_BYTES) {
      await this.reactToMessage(userMessage, REACTION_ERROR);
      await reply(`Attachment is too large. Limit: ${formatBytes(MAX_ATTACHMENT_BYTES)}.`);
      return;
    }

    this.beginTurn(userMessage, false);
    await this.reactToMessage(userMessage, REACTION_WORKING, true);

    try {
      const saved = await this.downloadTelegramFile(fileId, fileName, mimeType);
      this.fileDelivery.trackTurnTempFile(saved.path);
      const input = this.buildAttachmentInput(saved, caption);
      await this.startCodexTurn(userMessage, input, reply, true, true);
    } catch (error) {
      await this.failTurnSetup(userMessage, reply, "Attachment error", error);
    }
  }

  private async handleVoiceMessage(
    userMessage: UserMessageRef,
    reply: (text: string) => Promise<unknown>,
    fileId: string,
    mimeType: string | undefined,
    fileSize: number | undefined,
  ): Promise<void> {
    if (this.turn.isBusy) {
      await this.replyBusy(userMessage, reply);
      return;
    }

    if (fileSize && fileSize > MAX_ATTACHMENT_BYTES) {
      await this.reactToMessage(userMessage, REACTION_ERROR);
      await reply(`Voice message is too large. Limit: ${formatBytes(MAX_ATTACHMENT_BYTES)}.`);
      return;
    }

    this.beginTurn(userMessage, true);
    await this.reactToMessage(userMessage, REACTION_WORKING, true);

    try {
      const saved = await this.downloadTelegramFile(fileId, "telegram-voice.ogg", mimeType ?? "audio/ogg");
      let transcript: string;
      try {
        transcript = await this.options.voice.transcribe(saved.path);
      } finally {
        await this.fileDelivery.removeTemporaryFileIfManaged(saved.path);
      }

      if (!transcript) {
        throw new Error("whisper.cpp returned an empty transcript");
      }

      await this.startCodexTurn(
        userMessage,
        [
          {
            type: "text",
            text: [
              "An English Telegram voice message was transcribed locally with whisper.cpp.",
              "Use the transcript below as the user's request and respond normally.",
              "The bridge may send your final answer back to Telegram as a voice note.",
              "",
              "<transcript>",
              transcript,
              "</transcript>",
            ].join("\n"),
          },
        ],
        reply,
        true,
        true,
        this.options.voice.replyWithVoice,
      );
    } catch (error) {
      await this.failTurnSetup(userMessage, reply, "Voice error", error);
    }
  }

  private buildAttachmentInput(attachment: SavedAttachment, caption: string | undefined): CodexInputItem[] {
    const text = [
      `User sent a Telegram attachment saved at: ${attachment.path}`,
      `Original filename: ${attachment.originalName}`,
      `MIME type: ${attachment.mimeType ?? "unknown"}`,
      caption?.trim() ? `Caption: ${caption.trim()}` : undefined,
      attachment.isImage
        ? "Inspect the attached image and respond to the user's request."
        : "Inspect the local file path above and respond to the user's request.",
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");

    if (attachment.isImage && this.options.supportsImageInput) {
      return [
        { type: "text", text },
        { type: "localImage", path: attachment.path },
      ];
    }

    if (attachment.isImage) {
      return [
        {
          type: "text",
          text: `${text}\n\nNote: the selected Codex model does not advertise image input support, so use the saved file path if possible.`,
        },
      ];
    }

    return [{ type: "text", text }];
  }

  private async startCodexTurn(
    userMessage: UserMessageRef,
    input: CodexInputItem[],
    reply: (text: string) => Promise<unknown>,
    alreadyReacted = false,
    alreadyBusy = false,
    replyAsVoice = false,
  ): Promise<void> {
    if (!alreadyBusy && this.turn.isBusy) {
      await this.replyBusy(userMessage, reply);
      return;
    }

    if (!alreadyBusy) {
      this.beginTurn(userMessage, replyAsVoice);
    }

    if (alreadyBusy) {
      this.turn.setReplyAsVoice(replyAsVoice);
    }

    if (!alreadyReacted) {
      await this.reactToMessage(userMessage, REACTION_WORKING, true);
    }

    try {
      const turnId = await this.options.codex.startTurn(
        this.options.threadId,
        input,
        this.options.projectRoot,
        this.options.reasoningLevel,
      );
      this.turn.setTurnId(turnId);
    } catch (error) {
      await this.failTurnSetup(userMessage, reply, "Codex error", error);
    }
  }

  private async replyBusy(userMessage: UserMessageRef, reply: (text: string) => Promise<unknown>): Promise<void> {
    await this.reactToMessage(userMessage, REACTION_WORKING);
    await reply("Codex is already working. Use /interrupt to stop the active turn.");
  }

  private beginTurn(userMessage: UserMessageRef, replyAsVoice: boolean): void {
    this.turn.begin(userMessage, replyAsVoice);
    this.fileDelivery.clearTrackedTurnTempFiles();
    this.startTyping();
  }

  private async failTurnSetup(
    userMessage: UserMessageRef,
    reply: (text: string) => Promise<unknown>,
    label: string,
    error: unknown,
  ): Promise<void> {
    this.turn.failSetup();
    this.stopTyping();
    await this.fileDelivery.cleanupTurnTempFiles();
    await this.reactToMessage(userMessage, REACTION_ERROR, true);
    await reply(`${label}: ${formatError(error)}`);
  }

  private async downloadTelegramFile(
    fileId: string,
    originalName: string,
    mimeType: string | undefined,
  ): Promise<SavedAttachment> {
    const link = await this.bot.telegram.getFileLink(fileId);
    const response = await fetch(link);
    if (!response.ok) {
      throw new Error(`Telegram download failed: ${response.status} ${response.statusText}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Attachment is too large. Limit: ${formatBytes(MAX_ATTACHMENT_BYTES)}.`);
    }

    const directory = path.join(this.options.temporaryRoot, ATTACHMENT_DIR);
    const safeName = buildSafeAttachmentName(originalName, mimeType);
    const filePath = path.join(directory, safeName);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(filePath, buffer, { mode: 0o600 });

    return {
      path: filePath,
      originalName,
      mimeType,
      isImage: isImageAttachment(originalName, mimeType),
    };
  }

  private async handleCodexNotification(message: { method?: string; params?: unknown }): Promise<void> {
    if (message.method === "item/agentMessage/delta") {
      const delta = (message.params as { delta?: unknown })?.delta;
      if (typeof delta === "string") {
        this.turn.appendDelta(delta);
      }
      return;
    }

    if (message.method === "turn/started") {
      const turnId = (message.params as { turn?: { id?: unknown } })?.turn?.id;
      if (typeof turnId === "string") {
        this.turn.setTurnId(turnId);
      }
      return;
    }

    if (message.method === "item/completed") {
      const agentMessage = readCompletedAgentMessage(message.params);
      if (agentMessage) {
        this.turn.appendAgentMessage(agentMessage);
      }
      return;
    }

    if (message.method === "turn/completed") {
      const completedTurn = this.turn.complete();
      this.stopTyping();
      const { text, requests, skippedFileCount } = extractFileSendRequests(completedTurn.replyText);
      try {
        await this.reactToMessage(completedTurn.userMessage, REACTION_DONE);
        if (text) {
          await this.sendReplyText(text, completedTurn.replyAsVoice);
        } else if (requests.length === 0) {
          await this.sendLongMessage("Codex turn completed.");
        }

        if (skippedFileCount > 0) {
          await this.sendLongMessage(`Skipped ${skippedFileCount} extra file request(s). Limit: ${MAX_FILE_SENDS_PER_TURN}.`);
        }

        for (const request of requests) {
          await this.fileDelivery.sendRequestedFile(request);
        }
      } finally {
        await this.fileDelivery.cleanupTurnTempFiles();
      }
    }
  }

  private statusText(): string {
    return [
      "Codex Telegram Bridge is running in YOLO mode.",
      `Project: ${this.options.projectRoot}`,
      `Thread: ${this.options.threadId}`,
      `Reasoning level: ${this.options.reasoningLevel}`,
      `Temporary files: ${this.options.temporaryRoot}`,
      `File send roots: ${this.options.fileSendRoots.join(", ")}`,
      `File send max: ${formatBytes(this.options.fileSendMaxBytes)}`,
      ...this.options.voice.statusLines(),
      `Busy: ${this.turn.isBusy ? "yes" : "no"}`,
    ].join("\n");
  }

  private async sendReplyText(text: string, replyAsVoice: boolean): Promise<void> {
    if (!replyAsVoice) {
      await this.sendLongMessage(text);
      return;
    }

    try {
      await this.sendVoiceReply(text);
    } catch (error) {
      await this.sendLongMessage(`Voice reply error: ${formatError(error)}\n\n${text}`);
    }
  }

  private async sendVoiceReply(text: string): Promise<void> {
    await this.bot.telegram.sendChatAction(this.options.allowedUserId, "record_voice");
    const voice = await this.options.voice.synthesizeTelegramVoice(text);
    try {
      await this.bot.telegram.sendChatAction(this.options.allowedUserId, "upload_voice");
      await this.bot.telegram.sendVoice(this.options.allowedUserId, { source: voice.path });
    } finally {
      await this.options.voice.removeSynthesizedVoice(voice);
    }

    if (voice.truncated) {
      await this.sendLongMessage(`Voice reply was truncated to ${voice.text.length} characters.\n\n${text}`);
    }
  }

  private async sendLongMessage(text: string): Promise<void> {
    const limit = 3900;
    for (let i = 0; i < text.length; i += limit) {
      await this.bot.telegram.sendMessage(this.options.allowedUserId, text.slice(i, i + limit));
    }
  }

  private startTyping(): void {
    this.stopTyping();
    void this.sendTyping();
    this.typingTimer = setInterval(() => {
      void this.sendTyping();
    }, 4000);
  }

  private stopTyping(): void {
    if (!this.typingTimer) {
      return;
    }

    clearInterval(this.typingTimer);
    this.typingTimer = undefined;
  }

  private async sendTyping(): Promise<void> {
    try {
      await this.bot.telegram.sendChatAction(this.options.allowedUserId, "typing");
    } catch (error) {
      console.error(`Telegram typing indicator error: ${formatError(error)}`);
    }
  }

  private async reactToMessage(message: UserMessageRef | undefined, emoji: TelegramEmoji, isBig = false): Promise<void> {
    if (!message) {
      return;
    }

    try {
      await this.bot.telegram.setMessageReaction(message.chatId, message.messageId, [{ type: "emoji", emoji }], isBig);
    } catch (error) {
      console.error(`Telegram reaction error: ${formatError(error)}`);
    }
  }

  private isAllowedPrivateUser(chatType: string | undefined, userId: number | undefined): boolean {
    return chatType === "private" && userId === this.options.allowedUserId;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
