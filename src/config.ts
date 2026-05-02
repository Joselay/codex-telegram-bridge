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
  model: "gpt-5.5";
  reasoningLevel: "high";
  telegramBotToken: string;
  allowedTelegramUserId: number;
  telegramFileSendRoots: string[];
  telegramFileSendMaxBytes: number;
  voice: VoiceConfig;
};

export type ReasoningLevel = "high";
export type ConfigReasoningLevel = ReasoningLevel;

const FIXED_MODEL = "gpt-5.5";
const FIXED_REASONING_LEVEL = "high";
const FILE_SEND_MAX_BYTES = 50 * 1024 * 1024;
const REPLY_WITH_VOICE = true;
const VOICE_REPLY_MAX_CHARS = 3500;
const LOCAL_WHISPER_BIN = path.join(os.homedir(), "whisper.cpp-build", "bin", "whisper-cli");
const LOCAL_WHISPER_MODEL = path.join(os.homedir(), "whisper-models", "ggml-large-v3-turbo-q5_0.bin");

export function loadConfig(): AppConfig {
  const args = process.argv.slice(2);
  const cwdArg = readArg(args, "--cwd") ?? process.cwd();
  const yolo = args.includes("--yolo");
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
  const allowedTelegramUserId = readPositiveIntegerEnv("TELEGRAM_ALLOWED_USER_ID");

  if (!telegramBotToken) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN in environment or .env");
  }

  if (!yolo) {
    throw new Error("This bridge is currently designed for cdxyt yolo mode. Run with --yolo.");
  }

  return {
    cwd: path.resolve(cwdArg),
    yolo,
    model: FIXED_MODEL,
    reasoningLevel: FIXED_REASONING_LEVEL,
    telegramBotToken,
    allowedTelegramUserId,
    telegramFileSendRoots: [os.homedir()],
    telegramFileSendMaxBytes: FILE_SEND_MAX_BYTES,
    voice: readVoiceConfig(),
  };
}

function readVoiceConfig(): VoiceConfig {
  return {
    whisperBin: resolveCommand(LOCAL_WHISPER_BIN),
    whisperModel: path.resolve(LOCAL_WHISPER_MODEL),
    whisperLanguage: "en",
    ffmpegBin: firstExistingPath(["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]) ?? "ffmpeg",
    ttsSayBin: firstExistingPath(["/usr/bin/say"]) ?? "say",
    ttsVoice: undefined,
    replyWithVoice: REPLY_WITH_VOICE,
    maxReplyChars: VOICE_REPLY_MAX_CHARS,
  };
}

function readArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }

  return value;
}

function readPositiveIntegerEnv(name: string): number {
  const rawValue = process.env[name];
  const value = Number(rawValue);

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Missing or invalid ${name} in environment or .env`);
  }

  return value;
}

function firstExistingPath(paths: string[]): string | undefined {
  return paths.find((candidate) => fs.existsSync(candidate));
}

function resolveCommand(value: string): string {
  return value.includes(path.sep) ? path.resolve(value) : value;
}
