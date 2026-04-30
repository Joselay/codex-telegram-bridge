import { Telegraf } from "telegraf";
import type { CodexClient } from "./codexClient.js";
import type { ReasoningEffort } from "./config.js";

type TelegramBotOptions = {
  token: string;
  allowedUserId: number;
  projectRoot: string;
  threadId: string;
  reasoningEffort: ReasoningEffort;
  codex: CodexClient;
  onStop: () => void;
};

export class TelegramBridgeBot {
  private readonly bot: Telegraf;
  private activeTurnId: string | undefined;
  private busy = false;
  private readonly chunks: string[] = [];

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
    this.bot.stop();
  }

  private registerHandlers(): void {
    this.bot.use(async (ctx, next) => {
      if (ctx.from?.id !== this.options.allowedUserId) {
        await ctx.reply("Unauthorized.");
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
      await ctx.reply("Sent to Codex yolo session.");

      try {
        this.activeTurnId = await this.options.codex.startTurn(
          this.options.threadId,
          text,
          this.options.projectRoot,
          this.options.reasoningEffort,
        );
      } catch (error) {
        this.busy = false;
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

    if (message.method === "turn/completed") {
      this.busy = false;
      this.activeTurnId = undefined;
      const text = this.chunks.join("").trim();
      this.chunks.length = 0;
      await this.sendLongMessage(text || "Codex turn completed.");
    }
  }

  private statusText(): string {
    return [
      "Codex Telegram Bridge is running in YOLO mode.",
      `Project: ${this.options.projectRoot}`,
      `Thread: ${this.options.threadId}`,
      `Model effort: ${this.options.reasoningEffort}`,
      `Busy: ${this.busy ? "yes" : "no"}`,
    ].join("\n");
  }

  private async sendLongMessage(text: string): Promise<void> {
    const limit = 3900;
    for (let i = 0; i < text.length; i += limit) {
      await this.bot.telegram.sendMessage(this.options.allowedUserId, text.slice(i, i + limit));
    }
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
