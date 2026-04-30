import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";

dotenv.config();

export type AppConfig = {
  cwd: string;
  yolo: boolean;
  model: string;
  reasoningEffort: ReasoningEffort;
  storePath: string;
  telegramBotToken: string;
  allowedTelegramUserId: number;
};

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export function loadConfig(): AppConfig {
  const args = process.argv.slice(2);
  const cwdArg = readArg(args, "--cwd") ?? process.cwd();
  const yolo = args.includes("--yolo");
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
  const allowedTelegramUserId = Number(process.env.TELEGRAM_ALLOWED_USER_ID);

  if (!telegramBotToken) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN in environment or .env");
  }

  if (!Number.isSafeInteger(allowedTelegramUserId)) {
    throw new Error("Missing or invalid TELEGRAM_ALLOWED_USER_ID in environment or .env");
  }

  if (!yolo) {
    throw new Error("This bridge is currently designed for cdxyt yolo mode. Run with --yolo.");
  }

  return {
    cwd: path.resolve(cwdArg),
    yolo,
    model: process.env.CODEX_MODEL ?? "gpt-5.5",
    reasoningEffort: readReasoningEffort(process.env.CODEX_REASONING_EFFORT ?? "high"),
    storePath: path.resolve(process.env.CODEX_TELEGRAM_STORE ?? ".codex-telegram-store.json"),
    telegramBotToken,
    allowedTelegramUserId,
  };
}

function readReasoningEffort(value: string): ReasoningEffort {
  if (["none", "minimal", "low", "medium", "high", "xhigh"].includes(value)) {
    return value as ReasoningEffort;
  }

  throw new Error(`Invalid CODEX_REASONING_EFFORT: ${value}`);
}

function readArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  return args[index + 1];
}
