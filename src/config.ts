import path from "node:path";
import process from "node:process";
import os from "node:os";
import dotenv from "dotenv";

dotenv.config();

export type AppConfig = {
  cwd: string;
  yolo: boolean;
  model: string;
  reasoningLevel: ReasoningLevel;
  storePath: string;
  telegramBotToken: string;
  allowedTelegramUserId: number;
  telegramFileSendRoots: string[];
  telegramFileSendMaxBytes: number;
};

export type ReasoningLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type ConfigReasoningLevel = Exclude<ReasoningLevel, "none">;

export function loadConfig(): AppConfig {
  const args = process.argv.slice(2);
  const cwdArg = readArg(args, "--cwd") ?? process.cwd();
  const yolo = args.includes("--yolo");
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
  const allowedTelegramUserId = Number(process.env.TELEGRAM_ALLOWED_USER_ID);

  if (!telegramBotToken) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN in environment or .env");
  }

  if (!Number.isSafeInteger(allowedTelegramUserId) || allowedTelegramUserId <= 0) {
    throw new Error("Missing or invalid TELEGRAM_ALLOWED_USER_ID in environment or .env");
  }

  if (!yolo) {
    throw new Error("This bridge is currently designed for cdxyt yolo mode. Run with --yolo.");
  }

  return {
    cwd: path.resolve(cwdArg),
    yolo,
    model: process.env.CODEX_MODEL ?? "gpt-5.5",
    reasoningLevel: readReasoningLevel(process.env.CODEX_REASONING_LEVEL ?? "high"),
    storePath: path.resolve(process.env.CODEX_TELEGRAM_STORE ?? ".codex-telegram-store.json"),
    telegramBotToken,
    allowedTelegramUserId,
    telegramFileSendRoots: readPathList(process.env.TELEGRAM_FILE_SEND_ROOTS ?? os.homedir()),
    telegramFileSendMaxBytes: readMegabytes(process.env.TELEGRAM_FILE_SEND_MAX_MB ?? "50", "TELEGRAM_FILE_SEND_MAX_MB"),
  };
}

function readReasoningLevel(value: string): ReasoningLevel {
  if (["none", "minimal", "low", "medium", "high", "xhigh"].includes(value)) {
    return value as ReasoningLevel;
  }

  throw new Error(`Invalid CODEX_REASONING_LEVEL: ${value}`);
}

function readArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  return args[index + 1];
}

function readPathList(value: string): string[] {
  const paths = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map(expandHome)
    .map((item) => path.resolve(item));

  if (paths.length === 0) {
    throw new Error("TELEGRAM_FILE_SEND_ROOTS must include at least one path");
  }

  return paths;
}

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }

  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }

  return value;
}

function readMegabytes(value: string, name: string): number {
  const megabytes = Number(value);
  if (!Number.isFinite(megabytes) || megabytes <= 0) {
    throw new Error(`${name} must be a positive number`);
  }

  return Math.floor(megabytes * 1024 * 1024);
}
