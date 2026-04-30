import { Telegraf } from "telegraf";
import type { CodexClient } from "./codex-client.js";
import type { ReasoningLevel } from "./config.js";

type TelegramBotOptions = {
  token: string;
  allowedUserId: number;
  projectRoot: string;
  threadId: string;
  reasoningLevel: ReasoningLevel;
  codex: CodexClient;
  onStop: () => void;
};

type AgentMessagePhase = "commentary" | "final_answer";

type AgentMessage = {
  text: string;
  phase?: AgentMessagePhase;
};

export class TelegramBridgeBot {
  private readonly bot: Telegraf;
  private activeTurnId: string | undefined;
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
      if (!text || text.startsWith("/")) {
        return;
      }

      if (this.busy) {
        await ctx.reply("Codex is already working. Use /interrupt to stop the active turn.");
        return;
      }

      this.busy = true;
      this.activeTurnId = undefined;
      this.chunks.length = 0;
      this.agentMessages.length = 0;
      this.startTyping();

      try {
        this.activeTurnId = await this.options.codex.startTurn(
          this.options.threadId,
          text,
          this.options.projectRoot,
          this.options.reasoningLevel,
        );
      } catch (error) {
        this.busy = false;
        this.stopTyping();
        await ctx.reply(`Codex error: ${formatError(error)}`);
      }
    });
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
      this.stopTyping();
      const text = this.buildReplyText();
      this.chunks.length = 0;
      this.agentMessages.length = 0;
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

  private isAllowedPrivateUser(chatType: string | undefined, userId: number | undefined): boolean {
    return chatType === "private" && userId === this.options.allowedUserId;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
