import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { formatError, makeTimestampedId, removeFileIfExists } from "./runtime.js";

export type VoiceConfig = {
  whisperBin: string;
  whisperModel: string;
  whisperLanguage: string;
  ffmpegBin: string;
  ttsSayBin: string;
  ttsVoice: string | undefined;
  replyWithVoice: boolean;
  maxReplyChars: number;
};

type SynthesizedVoice = {
  path: string;
  text: string;
  truncated: boolean;
};

const VOICE_DIR = "voice";

export class VoiceService {
  constructor(
    private readonly config: VoiceConfig,
    private readonly temporaryRoot: string,
  ) {}

  async validate(): Promise<void> {
    await assertFileReadable(this.config.whisperModel, "WHISPER_CPP_MODEL");
    await assertCommandAvailable(this.config.whisperBin, "WHISPER_CPP_BIN", ["-h"]);
    await assertCommandAvailable(this.config.ffmpegBin, "FFMPEG_BIN", ["-version"]);
    await this.validateWhisperModelLoads();

    if (this.config.replyWithVoice) {
      await assertCommandAvailable(this.config.ttsSayBin, "TELEGRAM_TTS_SAY_BIN", ["-v", "?"]);
    }
  }

  async transcribe(inputPath: string): Promise<string> {
    const wavPath = await this.convertToWhisperWav(inputPath);

    try {
      const result = await runCommand(
        this.config.whisperBin,
        [
          "-m",
          this.config.whisperModel,
          "-f",
          wavPath,
          "-np",
          "-nt",
          "-l",
          this.config.whisperLanguage,
        ],
        5 * 60 * 1000,
      );

      return cleanTranscript(result.stdout);
    } finally {
      await removeIfExists(wavPath);
    }
  }

  async validateWhisperModelLoads(): Promise<void> {
    const directory = path.join(this.temporaryRoot, VOICE_DIR);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });

    const wavPath = path.join(directory, `${makeTimestampedId("validate")}.wav`);

    try {
      await runCommand(
        this.config.ffmpegBin,
        [
          "-y",
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "anullsrc=r=16000:cl=mono",
          "-t",
          "0.1",
          "-c:a",
          "pcm_s16le",
          wavPath,
        ],
        10 * 1000,
      );
      await runCommand(
        this.config.whisperBin,
        [
          "-m",
          this.config.whisperModel,
          "-f",
          wavPath,
          "-np",
          "-nt",
          "-l",
          this.config.whisperLanguage,
          "-d",
          "100",
        ],
        30 * 1000,
      );
    } finally {
      await removeIfExists(wavPath);
    }
  }

  async synthesizeTelegramVoice(text: string): Promise<SynthesizedVoice> {
    const directory = path.join(this.temporaryRoot, VOICE_DIR);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });

    const id = makeTimestampedId();
    const textPath = path.join(directory, `${id}.txt`);
    const aiffPath = path.join(directory, `${id}.aiff`);
    const oggPath = path.join(directory, `${id}.ogg`);
    const normalizedText = normalizeSpeechText(text);
    const speechText = normalizedText.slice(0, this.config.maxReplyChars);
    const truncated = normalizedText.length > speechText.length;

    await fs.writeFile(textPath, speechText, { mode: 0o600 });

    const sayArgs = ["-o", aiffPath];
    if (this.config.ttsVoice) {
      sayArgs.push("-v", this.config.ttsVoice);
    }
    sayArgs.push("-f", textPath);

    try {
      await runCommand(this.config.ttsSayBin, sayArgs, 2 * 60 * 1000);
      await runCommand(
        this.config.ffmpegBin,
        [
          "-y",
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          aiffPath,
          "-c:a",
          "libopus",
          "-b:a",
          "32k",
          "-vbr",
          "on",
          "-application",
          "voip",
          oggPath,
        ],
        2 * 60 * 1000,
      );
    } finally {
      await Promise.all([removeIfExists(textPath), removeIfExists(aiffPath)]);
    }

    return {
      path: oggPath,
      text: speechText,
      truncated,
    };
  }

  get replyWithVoice(): boolean {
    return this.config.replyWithVoice;
  }

  async removeSynthesizedVoice(voice: SynthesizedVoice): Promise<void> {
    await removeIfExists(voice.path);
  }

  private async convertToWhisperWav(inputPath: string): Promise<string> {
    const directory = path.join(this.temporaryRoot, VOICE_DIR);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });

    const wavPath = path.join(directory, `${makeTimestampedId("whisper")}.wav`);

    await runCommand(
      this.config.ffmpegBin,
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        inputPath,
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        wavPath,
      ],
      2 * 60 * 1000,
    );

    return wavPath;
  }
}

async function assertFileReadable(filePath: string, label: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(`${label} is not readable: ${filePath}`);
  }
}

async function assertCommandAvailable(command: string, label: string, args: string[]): Promise<void> {
  try {
    await runCommand(command, args, 10 * 1000);
  } catch (error) {
    throw new Error(`${label} is not available (${command}): ${formatError(error)}`);
  }
}

function runCommand(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      callback();
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      settle(() => {
        reject(new Error(`${command} timed out`));
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });

    child.on("error", (error) => {
      settle(() => {
        reject(error);
      });
    });

    child.on("close", (code, signal) => {
      settle(() => {
        const stdoutText = Buffer.concat(stdout).toString("utf8");
        const stderrText = Buffer.concat(stderr).toString("utf8");

        if (code !== 0) {
          reject(new Error(`${command} failed: ${stderrText.trim() || `code=${code} signal=${signal ?? "none"}`}`));
          return;
        }

        resolve({ stdout: stdoutText, stderr: stderrText });
      });
    });
  });
}

function cleanTranscript(value: string): string {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSpeechText(value: string): string {
  return value
    .replace(/\[\[telegram_send_(?:file|document|photo|both):[^\]\r\n]+?\]\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function removeIfExists(filePath: string): Promise<void> {
  await removeFileIfExists(filePath);
}
