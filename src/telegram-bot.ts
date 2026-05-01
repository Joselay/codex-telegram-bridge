import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Telegraf } from "telegraf";
import type { TelegramEmoji } from "telegraf/types";
import type { CodexClient, CodexInputItem } from "./codex-client.js";
import type { ReasoningLevel } from "./config.js";

type TelegramBotOptions = {
  token: string;
  allowedUserId: number;
  projectRoot: string;
  threadId: string;
  reasoningLevel: ReasoningLevel;
  supportsImageInput: boolean;
  codex: CodexClient;
  onStop: () => void;
};

type AgentMessagePhase = "commentary" | "final_answer";

type AgentMessage = {
  text: string;
  phase?: AgentMessagePhase;
};

type UserMessageRef = {
  chatId: number | string;
  messageId: number;
};

const REACTION_WORKING: TelegramEmoji = "👀";
const REACTION_DONE: TelegramEmoji = "👌";
const REACTION_ERROR: TelegramEmoji = "😢";
const ATTACHMENT_DIR = ".codex-telegram-attachments";
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export class TelegramBridgeBot {
  private readonly bot: Telegraf;
  private activeTurnId: string | undefined;
  private activeUserMessage: UserMessageRef | undefined;
  private busy = false;
  private typingTimer: ReturnType<typeof setInterval> | undefined;
  private readonly chunks: string[] = [];
  private readonly agentMessages: AgentMessage[] = [];

  constructor(private readonly options: TelegramBotOptions) {
    this.bot = new Telegraf(options.token);
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
      if (!this.activeTurnId) {
        await ctx.reply("No active turn to interrupt.");
        return;
      }

      await this.options.codex.interrupt(this.options.threadId, this.activeTurnId);
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
    if (this.busy) {
      await this.reactToMessage(userMessage, REACTION_WORKING);
      await reply("Codex is already working. Use /interrupt to stop the active turn.");
      return;
    }

    if (fileSize && fileSize > MAX_ATTACHMENT_BYTES) {
      await this.reactToMessage(userMessage, REACTION_ERROR);
      await reply(`Attachment is too large. Limit: ${formatBytes(MAX_ATTACHMENT_BYTES)}.`);
      return;
    }

    this.busy = true;
    this.activeTurnId = undefined;
    this.activeUserMessage = userMessage;
    this.chunks.length = 0;
    this.agentMessages.length = 0;
    this.startTyping();
    await this.reactToMessage(userMessage, REACTION_WORKING, true);

    try {
      const saved = await this.downloadTelegramFile(fileId, fileName, mimeType);
      const input = this.buildAttachmentInput(saved, caption);
      await this.startCodexTurn(userMessage, input, reply, true, true);
    } catch (error) {
      this.busy = false;
      this.activeUserMessage = undefined;
      this.stopTyping();
      await this.reactToMessage(userMessage, REACTION_ERROR, true);
      await reply(`Attachment error: ${formatError(error)}`);
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
  ): Promise<void> {
    if (!alreadyBusy && this.busy) {
      await this.reactToMessage(userMessage, REACTION_WORKING);
      await reply("Codex is already working. Use /interrupt to stop the active turn.");
      return;
    }

    if (!alreadyBusy) {
      this.busy = true;
      this.activeTurnId = undefined;
      this.activeUserMessage = userMessage;
      this.chunks.length = 0;
      this.agentMessages.length = 0;
      this.startTyping();
    }

    if (!alreadyReacted) {
      await this.reactToMessage(userMessage, REACTION_WORKING, true);
    }

    try {
      this.activeTurnId = await this.options.codex.startTurn(
        this.options.threadId,
        input,
        this.options.projectRoot,
        this.options.reasoningLevel,
      );
    } catch (error) {
      this.busy = false;
      this.activeUserMessage = undefined;
      this.stopTyping();
      await this.reactToMessage(userMessage, REACTION_ERROR, true);
      await reply(`Codex error: ${formatError(error)}`);
    }
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

    const directory = path.join(this.options.projectRoot, ATTACHMENT_DIR);
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
        this.chunks.push(delta);
      }
      return;
    }

    if (message.method === "turn/started") {
      const turnId = (message.params as { turn?: { id?: unknown } })?.turn?.id;
      if (typeof turnId === "string") {
        this.activeTurnId = turnId;
      }
      return;
    }

    if (message.method === "item/completed") {
      const agentMessage = readCompletedAgentMessage(message.params);
      if (agentMessage) {
        this.agentMessages.push(agentMessage);
      }
      return;
    }

    if (message.method === "turn/completed") {
      this.busy = false;
      this.activeTurnId = undefined;
      const userMessage = this.activeUserMessage;
      this.activeUserMessage = undefined;
      this.stopTyping();
      const text = this.buildReplyText();
      this.chunks.length = 0;
      this.agentMessages.length = 0;
      await this.reactToMessage(userMessage, REACTION_DONE);
      await this.sendLongMessage(text || "Codex turn completed.");
    }
  }

  private buildReplyText(): string {
    const finalMessages = this.agentMessages
      .filter((message) => message.phase === "final_answer")
      .map((message) => message.text);

    if (finalMessages.length > 0) {
      return cleanTelegramText(finalMessages.join("\n\n"));
    }

    const unknownPhaseMessages = this.agentMessages
      .filter((message) => !message.phase)
      .map((message) => message.text);

    if (unknownPhaseMessages.length > 0) {
      return cleanTelegramText(unknownPhaseMessages.join("\n\n"));
    }

    return cleanTelegramText(this.chunks.join(""));
  }

  private statusText(): string {
    return [
      "Codex Telegram Bridge is running in YOLO mode.",
      `Project: ${this.options.projectRoot}`,
      `Thread: ${this.options.threadId}`,
      `Reasoning level: ${this.options.reasoningLevel}`,
      `Busy: ${this.busy ? "yes" : "no"}`,
    ].join("\n");
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

type SavedAttachment = {
  path: string;
  originalName: string;
  mimeType: string | undefined;
  isImage: boolean;
};

function buildSafeAttachmentName(originalName: string, mimeType: string | undefined): string {
  const parsed = path.parse(originalName);
  const base = parsed.name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "attachment";
  const ext = (parsed.ext || extensionForMimeType(mimeType)).replace(/[^a-zA-Z0-9.]/g, "");
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}-${base}${ext}`;
}

function extensionForMimeType(mimeType: string | undefined): string {
  switch (mimeType) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "application/pdf":
      return ".pdf";
    case "text/plain":
      return ".txt";
    default:
      return "";
  }
}

function isImageAttachment(fileName: string, mimeType: string | undefined): boolean {
  if (mimeType?.startsWith("image/")) {
    return true;
  }

  return [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(path.extname(fileName).toLowerCase());
}

function formatBytes(bytes: number): string {
  const megabytes = bytes / 1024 / 1024;
  return `${megabytes.toFixed(megabytes >= 10 ? 0 : 1)} MB`;
}

function readCompletedAgentMessage(params: unknown): AgentMessage | undefined {
  const item = (params as { item?: { type?: unknown; text?: unknown; phase?: unknown } })?.item;
  if (item?.type !== "agentMessage" || typeof item.text !== "string" || !item.text.trim()) {
    return undefined;
  }

  return {
    text: item.text,
    phase: readAgentMessagePhase(item.phase),
  };
}

function readAgentMessagePhase(value: unknown): AgentMessagePhase | undefined {
  return value === "commentary" || value === "final_answer" ? value : undefined;
}

function cleanTelegramText(text: string): string {
  return text
    .replace(/^```[^\n]*\n?/gm, "")
    .replace(/^```\s*$/gm, "")
    .replace(/\[([^\]]+)\]\((?:\/|file:\/\/)[^)]+\)/g, "$1")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
