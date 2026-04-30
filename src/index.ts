#!/usr/bin/env node
import { CodexClient } from "./codexClient.js";
import type { CodexModel } from "./codexClient.js";
import type { ReasoningLevel } from "./config.js";
import { loadConfig } from "./config.js";
import { resolveProjectRoot } from "./project.js";
import { SessionStore } from "./sessionStore.js";
import { TelegramBridgeBot } from "./telegramBot.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const projectRoot = await resolveProjectRoot(config.cwd);
  const store = new SessionStore(config.storePath);
  const codex = new CodexClient();

  printWarning(projectRoot);
  console.log("Starting Codex app-server...");
  await codex.start();
  console.log("Codex app-server initialized.");
  await validateModelConfig(codex, config.model, config.reasoningLevel);

  const existing = await store.get(projectRoot);
  console.log(existing ? `Resuming Codex thread ${existing.threadId}...` : "Starting a new Codex thread...");
  const threadId = existing
    ? await codex.resumeThread(existing.threadId, config.model, config.reasoningLevel)
    : await codex.startThread(projectRoot, config.model, config.reasoningLevel);
  console.log(`Codex thread ready: ${threadId}`);

  await store.set(projectRoot, {
    threadId,
    cwd: projectRoot,
    mode: "yolo",
    updatedAt: new Date().toISOString(),
  });

  const bot = new TelegramBridgeBot({
    token: config.telegramBotToken,
    allowedUserId: config.allowedTelegramUserId,
    projectRoot,
    threadId,
    reasoningLevel: config.reasoningLevel,
    codex,
    onStop: () => {
      bot.stop();
      codex.stop();
      process.exit(0);
    },
  });

  console.log("Starting Telegram bot polling...");
  bot.launch();

  console.log("Telegram bridge is running.");
  console.log(`Project: ${projectRoot}`);
  console.log(`Thread: ${threadId}`);

  process.once("SIGINT", () => {
    bot.stop();
    codex.stop();
    process.exit(0);
  });

  process.once("SIGTERM", () => {
    bot.stop();
    codex.stop();
    process.exit(0);
  });
}

function printWarning(projectRoot: string): void {
  console.warn("WARNING: cdxyt is starting Codex in YOLO mode.");
  console.warn('Codex will use approvalPolicy="never" and sandbox="danger-full-access".');
  console.warn(`Project: ${projectRoot}`);
}

async function validateModelConfig(codex: CodexClient, modelId: string, reasoningLevel: ReasoningLevel): Promise<void> {
  const models = await codex.listModels();
  const model = models.find((candidate) => candidate.id === modelId);

  if (!model) {
    throw new Error(`Codex model "${modelId}" is not available. Check CODEX_MODEL or run Codex /model.`);
  }

  const supportedEfforts = readSupportedReasoningEfforts(model);
  if (supportedEfforts.length === 0) {
    return;
  }

  if (!supportedEfforts.includes(reasoningLevel)) {
    throw new Error(
      `Codex model "${modelId}" does not support reasoning level "${reasoningLevel}". Supported: ${supportedEfforts.join(
        ", ",
      )}.`,
    );
  }
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
