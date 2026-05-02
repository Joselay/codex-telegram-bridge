import path from "node:path";
import process from "node:process";
import os from "node:os";
import fs from "node:fs";
import dotenv from "dotenv";
import type { VoiceConfig } from "./voice.js";

dotenv.config();

export type AppConfig = {
  cwd: string;
  yolo: boolean;
  model: string;
  reasoningLevel: ReasoningLevel;
  telegramBotToken: string;
  allowedTelegramUserId: number;
  telegramFileSendRoots: string[];
  telegramFileSendMaxBytes: number;
  voice: VoiceConfig;
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
    telegramBotToken,
    allowedTelegramUserId,
    telegramFileSendRoots: readPathList(process.env.TELEGRAM_FILE_SEND_ROOTS ?? os.homedir()),
    telegramFileSendMaxBytes: readMegabytes(process.env.TELEGRAM_FILE_SEND_MAX_MB ?? "50", "TELEGRAM_FILE_SEND_MAX_MB"),
    voice: readVoiceConfig(),
  };
}

function readVoiceConfig(): VoiceConfig {
  const whisperRoot = path.join(os.homedir(), "whisper.cpp");
  const defaultWhisperModel =
    firstExistingPath([
      path.join(whisperRoot, "models", "ggml-large-v3-turbo-q5_0.bin"),
      path.join(whisperRoot, "models", "ggml-large-v3-turbo.bin"),
      path.join(whisperRoot, "models", "ggml-medium.en.bin"),
      path.join(whisperRoot, "models", "ggml-medium.en-q5_0.bin"),
      path.join(whisperRoot, "models", "ggml-small.en.bin"),
      path.join(whisperRoot, "models", "ggml-small.en-q5_1.bin"),
      path.join(whisperRoot, "models", "ggml-base.en.bin"),
    ]) ?? path.join(whisperRoot, "models", "ggml-large-v3-turbo-q5_0.bin");

  return {
    whisperBin: resolveCommand(process.env.WHISPER_CPP_BIN ?? path.join(whisperRoot, "build", "bin", "whisper-cli")),
    whisperModel: path.resolve(expandHome(process.env.WHISPER_CPP_MODEL ?? defaultWhisperModel)),
    whisperLanguage: readWhisperLanguage(process.env.WHISPER_CPP_LANGUAGE ?? "en"),
    ffmpegBin: expandHome(
      process.env.FFMPEG_BIN ?? firstExistingPath(["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]) ?? "ffmpeg",
    ),
    ttsSayBin: expandHome(process.env.TELEGRAM_TTS_SAY_BIN ?? firstExistingPath(["/usr/bin/say"]) ?? "say"),
    ttsVoice: readOptionalString(process.env.TELEGRAM_TTS_VOICE),
    replyWithVoice: readBoolean(process.env.TELEGRAM_REPLY_WITH_VOICE ?? "true", "TELEGRAM_REPLY_WITH_VOICE"),
    maxReplyChars: readPositiveInteger(
      process.env.TELEGRAM_VOICE_REPLY_MAX_CHARS ?? "3500",
      "TELEGRAM_VOICE_REPLY_MAX_CHARS",
    ),
  };
}

function readReasoningLevel(value: string): ReasoningLevel {
  if (["none", "minimal", "low", "medium", "high", "xhigh"].includes(value)) {
    return value as ReasoningLevel;
  }

  throw new Error(`Invalid CODEX_REASONING_LEVEL: ${value}`);
}

function readWhisperLanguage(value: string): string {
  const language = value.trim().toLowerCase();
  if (language !== "en" && language !== "english") {
    throw new Error("This bridge is configured for English-only voice input. Set WHISPER_CPP_LANGUAGE=en.");
  }

  return "en";
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

function firstExistingPath(paths: string[]): string | undefined {
  return paths.find((candidate) => fs.existsSync(candidate));
}

function readOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveCommand(value: string): string {
  const expanded = expandHome(value);
  return expanded.includes(path.sep) ? path.resolve(expanded) : expanded;
}

function readBoolean(value: string, name: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`${name} must be true or false`);
}

function readPositiveInteger(value: string, name: string): number {
  const integer = Number(value);
  if (!Number.isSafeInteger(integer) || integer <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return integer;
}

function readMegabytes(value: string, name: string): number {
  const megabytes = Number(value);
  if (!Number.isFinite(megabytes) || megabytes <= 0) {
    throw new Error(`${name} must be a positive number`);
  }

  return Math.floor(megabytes * 1024 * 1024);
}
