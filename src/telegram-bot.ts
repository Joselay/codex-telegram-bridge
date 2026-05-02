import { Telegraf } from "telegraf";
import type { TelegramEmoji } from "telegraf/types";
import type { CodexClient, CodexInputItem } from "./codex-client.js";
import type { ReasoningLevel } from "./config.js";
import { formatError } from "./runtime.js";
import { MAX_ATTACHMENT_BYTES, TelegramAttachmentService } from "./telegram-attachments.js";
import { TelegramFileDelivery } from "./telegram-delivery.js";
import { formatBytes, MAX_FILE_SENDS_PER_TURN } from "./telegram-files.js";
import { sendLongTelegramMessage } from "./telegram-message.js";
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

type ReplyFn = (text: string) => Promise<unknown>;

type StartTurnOptions = {
  alreadyReacted?: boolean;
  turnAlreadyStarted?: boolean;
  replyAsVoice?: boolean;
};

const REACTION_WORKING: TelegramEmoji = "👀";
const REACTION_DONE: TelegramEmoji = "👌";
const REACTION_ERROR: TelegramEmoji = "😢";

export class TelegramBridgeBot {
  private readonly bot: Telegraf;
  private readonly attachments: TelegramAttachmentService;
  private readonly fileDelivery: TelegramFileDelivery;
  private readonly turn = new TelegramTurnState();
  private typingTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: TelegramBotOptions) {
    this.bot = new Telegraf(options.token);
    this.attachments = new TelegramAttachmentService({
      telegram: this.bot.telegram,
      temporaryRoot: options.temporaryRoot,
      supportsImageInput: options.supportsImageInput,
    });
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

    this.bot.on("text", async (ctx) => {
      const text = ctx.message.text.trim();
      const userMessage = buildUserMessageRef(ctx.chat.id, ctx.message.message_id);

      if (!text) {
        return;
      }

      await this.startCodexTurn(userMessage, [{ type: "text", text }], ctx.reply.bind(ctx));
    });

    this.bot.on("voice", async (ctx) => {
      const voice = ctx.message.voice;
      const userMessage = buildUserMessageRef(ctx.chat.id, ctx.message.message_id);

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
      const userMessage = buildUserMessageRef(ctx.chat.id, ctx.message.message_id);

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
      const userMessage = buildUserMessageRef(ctx.chat.id, ctx.message.message_id);

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
    reply: ReplyFn,
    fileId: string,
    fileName: string,
    mimeType: string | undefined,
    fileSize: number | undefined,
    caption: string | undefined,
  ): Promise<void> {
    if (!(await this.beginIncomingFileTurn(userMessage, reply, "Attachment", fileSize, false))) {
      return;
    }

    try {
      const saved = await this.attachments.download(fileId, fileName, mimeType);
      this.fileDelivery.trackTurnTempFile(saved.path);
      const input = this.attachments.buildCodexInput(saved, caption);
      await this.startCodexTurn(userMessage, input, reply, {
        alreadyReacted: true,
        turnAlreadyStarted: true,
      });
    } catch (error) {
      await this.failTurnSetup(userMessage, reply, "Attachment error", error);
    }
  }

  private async handleVoiceMessage(
    userMessage: UserMessageRef,
    reply: ReplyFn,
    fileId: string,
    mimeType: string | undefined,
    fileSize: number | undefined,
  ): Promise<void> {
    if (!(await this.beginIncomingFileTurn(userMessage, reply, "Voice message", fileSize, true))) {
      return;
    }

    try {
      const saved = await this.attachments.download(fileId, "telegram-voice.ogg", mimeType ?? "audio/ogg");
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
        buildVoiceTranscriptInput(transcript),
        reply,
        {
          alreadyReacted: true,
          turnAlreadyStarted: true,
          replyAsVoice: this.options.voice.replyWithVoice,
        },
      );
    } catch (error) {
      await this.failTurnSetup(userMessage, reply, "Voice error", error);
    }
  }

  private async beginIncomingFileTurn(
    userMessage: UserMessageRef,
    reply: ReplyFn,
    label: string,
    fileSize: number | undefined,
    replyAsVoice: boolean,
  ): Promise<boolean> {
    if (this.turn.isBusy) {
      await this.replyBusy(userMessage, reply);
      return false;
    }

    if (fileSize && fileSize > MAX_ATTACHMENT_BYTES) {
      await this.reactToMessage(userMessage, REACTION_ERROR);
      await reply(`${label} is too large. Limit: ${formatBytes(MAX_ATTACHMENT_BYTES)}.`);
      return false;
    }

    this.beginTurn(userMessage, replyAsVoice);
    await this.reactToMessage(userMessage, REACTION_WORKING, true);
    return true;
  }

  private async startCodexTurn(
    userMessage: UserMessageRef,
    input: CodexInputItem[],
    reply: ReplyFn,
    options: StartTurnOptions = {},
  ): Promise<void> {
    const alreadyReacted = options.alreadyReacted ?? false;
    const turnAlreadyStarted = options.turnAlreadyStarted ?? false;
    const replyAsVoice = options.replyAsVoice ?? false;

    if (!turnAlreadyStarted && this.turn.isBusy) {
      await this.replyBusy(userMessage, reply);
      return;
    }

    if (!turnAlreadyStarted) {
      this.beginTurn(userMessage, replyAsVoice);
    }

    if (turnAlreadyStarted) {
      this.turn.setReplyAsVoice(replyAsVoice);
    }

    if (!alreadyReacted) {
      await this.reactToMessage(userMessage, REACTION_WORKING, true);
    }

    try {
      await this.options.codex.startTurn(
        this.options.threadId,
        input,
        this.options.projectRoot,
        this.options.reasoningLevel,
      );
    } catch (error) {
      await this.failTurnSetup(userMessage, reply, "Codex error", error);
    }
  }

  private async replyBusy(userMessage: UserMessageRef, reply: ReplyFn): Promise<void> {
    await this.reactToMessage(userMessage, REACTION_WORKING);
    await reply("Codex is already working. Wait for the active turn to finish.");
  }

  private beginTurn(userMessage: UserMessageRef, replyAsVoice: boolean): void {
    this.turn.begin(userMessage, replyAsVoice);
    this.fileDelivery.clearTrackedTurnTempFiles();
    this.startTyping();
  }

  private async failTurnSetup(
    userMessage: UserMessageRef,
    reply: ReplyFn,
    label: string,
    error: unknown,
  ): Promise<void> {
    this.turn.failSetup();
    this.stopTyping();
    await this.fileDelivery.cleanupTurnTempFiles();
    await this.reactToMessage(userMessage, REACTION_ERROR, true);
    await reply(`${label}: ${formatError(error)}`);
  }

  private async handleCodexNotification(message: { method?: string; params?: unknown }): Promise<void> {
    switch (message.method) {
      case "item/agentMessage/delta":
        this.handleAgentMessageDelta(message.params);
        return;
      case "item/completed":
        this.handleItemCompleted(message.params);
        return;
      case "turn/completed":
        await this.handleTurnCompleted();
        return;
      default:
        return;
    }
  }

  private handleAgentMessageDelta(params: unknown): void {
    const delta = (params as { delta?: unknown })?.delta;
    if (typeof delta === "string") {
      this.turn.appendDelta(delta);
    }
  }

  private handleItemCompleted(params: unknown): void {
    const agentMessage = readCompletedAgentMessage(params);
    if (agentMessage) {
      this.turn.appendAgentMessage(agentMessage);
    }
  }

  private async handleTurnCompleted(): Promise<void> {
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
    await sendLongTelegramMessage(this.bot.telegram, this.options.allowedUserId, text);
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

function buildVoiceTranscriptInput(transcript: string): CodexInputItem[] {
  return [
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
  ];
}

function buildUserMessageRef(chatId: UserMessageRef["chatId"], messageId: number): UserMessageRef {
  return {
    chatId,
    messageId,
  };
}
