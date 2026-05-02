#!/usr/bin/env node
import { CodexClient } from "./codex-client.js";
import type { CodexModel } from "./codex-client.js";
import type { ReasoningLevel } from "./config.js";
import { loadConfig } from "./config.js";
import { resolveProjectRoot } from "./project.js";
import { SessionStore } from "./session-store.js";
import { TelegramBridgeBot } from "./telegram-bot.js";
import { VoiceService } from "./voice.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const projectRoot = await resolveProjectRoot(config.cwd);
  const store = new SessionStore(config.storePath);
  const codex = new CodexClient();
  const voice = new VoiceService(config.voice, projectRoot);
  let bot: TelegramBridgeBot | undefined;
  let stopping = false;

  const stop = (exitCode: number): void => {
    if (stopping) {
      return;
    }

    stopping = true;
    bot?.stop();
    codex.stop();
    process.exit(exitCode);
  };

  codex.on("exit", ({ code, signal }: { code: number | null; signal: NodeJS.Signals | null }) => {
    if (stopping) {
      return;
    }

    console.error(`Codex app-server exited unexpectedly: code=${code ?? "null"} signal=${signal ?? "null"}`);
    stop(1);
  });

  printWarning(projectRoot);
  console.log("Checking local voice toolchain...");
  await voice.validate();
  console.log("Voice toolchain ready.");

  console.log("Starting Codex app-server...");
  await codex.start();
  console.log("Codex app-server initialized.");
  const model = await validateModelConfig(codex, config.model, config.reasoningLevel);

  console.log("Starting a new Codex thread...");
  const threadId = await codex.startThread(
    projectRoot,
    config.model,
    config.reasoningLevel,
    buildDeveloperInstructions(),
  );
  console.log(`Codex thread ready: ${threadId}`);

  await store.set(projectRoot, {
    threadId,
    cwd: projectRoot,
    mode: "yolo",
    updatedAt: new Date().toISOString(),
  });

  bot = new TelegramBridgeBot({
    token: config.telegramBotToken,
    allowedUserId: config.allowedTelegramUserId,
    projectRoot,
    threadId,
    reasoningLevel: config.reasoningLevel,
    supportsImageInput: supportsImageInput(model),
    fileSendRoots: config.telegramFileSendRoots,
    fileSendMaxBytes: config.telegramFileSendMaxBytes,
    voice,
    codex,
    onStop: () => {
      stop(0);
    },
  });

  console.log("Starting Telegram bot polling...");
  bot.launch();

  console.log("Telegram bridge is running.");
  console.log(`Project: ${projectRoot}`);
  console.log(`Thread: ${threadId}`);

  process.once("SIGINT", () => {
    stop(0);
  });

  process.once("SIGTERM", () => {
    stop(0);
  });
}

function printWarning(projectRoot: string): void {
  console.warn("WARNING: cdxyt is starting Codex in YOLO mode.");
  console.warn('Codex will use approvalPolicy="never" and sandbox="danger-full-access".');
  console.warn(`Project: ${projectRoot}`);
}

async function validateModelConfig(
  codex: CodexClient,
  modelId: string,
  reasoningLevel: ReasoningLevel,
): Promise<CodexModel> {
  const models = await codex.listModels();
  const model = models.find((candidate) => candidate.id === modelId);

  if (!model) {
    throw new Error(`Codex model "${modelId}" is not available. Check CODEX_MODEL or run Codex /model.`);
  }

  const supportedEfforts = readSupportedReasoningEfforts(model);
  if (supportedEfforts.length === 0) {
    return model;
  }

  if (!supportedEfforts.includes(reasoningLevel)) {
    throw new Error(
      `Codex model "${modelId}" does not support reasoning level "${reasoningLevel}". Supported: ${supportedEfforts.join(
        ", ",
      )}.`,
    );
  }

  return model;
}

function readSupportedReasoningEfforts(model: CodexModel): ReasoningLevel[] {
  const efforts = model.supportedReasoningEfforts
    ?.map((effort) => effort.reasoningEffort)
    .filter((effort): effort is ReasoningLevel => typeof effort === "string");

  if (efforts?.length) {
    return efforts;
  }

  return model.defaultReasoningEffort ? [model.defaultReasoningEffort] : [];
}

function supportsImageInput(model: CodexModel): boolean {
  return !model.inputModalities || model.inputModalities.includes("image");
}

function buildDeveloperInstructions(): string {
  return [
    "Telegram bridge file delivery instructions:",
    "- When the user explicitly asks you to send, upload, or attach a local file in Telegram, find the file locally.",
    "- If one clear non-sensitive match should be sent as the original uncompressed file, include this exact marker in your final answer: [[telegram_send_file:/absolute/path/to/file]].",
    "- If the user asks to send an image as an inline Telegram photo, use: [[telegram_send_photo:/absolute/path/to/image]]. Telegram may compress or resize photos.",
    "- If the user asks for both a preview and the original image, use: [[telegram_send_both:/absolute/path/to/image]].",
    "- Use an absolute path in the marker. Do not put the marker in a code block.",
    "- If multiple plausible files are found, list numbered choices and wait for the user to pick one instead of sending automatically.",
    "- Never request sending secrets, credentials, private keys, token files, browser profiles, keychains, or .env files.",
  ].join("\n");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
