import { MAX_FILE_SENDS_PER_TURN } from "./telegram-files.js";
import type { TelegramSendMode, TelegramSendRequest } from "./telegram-files.js";

export type AgentMessagePhase = "commentary" | "final_answer";

export type AgentMessage = {
  text: string;
  phase?: AgentMessagePhase;
};

const FILE_SEND_MARKER_PATTERN = /\[\[telegram_send_(file|document|photo|both):([^\]\r\n]+?)\]\]/g;

export function readCompletedAgentMessage(params: unknown): AgentMessage | undefined {
  const item = (params as { item?: { type?: unknown; text?: unknown; phase?: unknown } })?.item;
  if (item?.type !== "agentMessage" || typeof item.text !== "string" || !item.text.trim()) {
    return undefined;
  }

  return {
    text: item.text,
    phase: readAgentMessagePhase(item.phase),
  };
}

export function cleanTelegramText(text: string): string {
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

export function extractFileSendRequests(text: string): {
  text: string;
  requests: TelegramSendRequest[];
  skippedFileCount: number;
} {
  const requests: TelegramSendRequest[] = [];
  let skippedFileCount = 0;
  const textWithoutMarkers = text.replace(FILE_SEND_MARKER_PATTERN, (_marker, markerMode: string, filePath: string) => {
    if (requests.length < MAX_FILE_SENDS_PER_TURN) {
      requests.push({
        path: filePath.trim(),
        mode: readTelegramSendMode(markerMode),
      });
    } else {
      skippedFileCount += 1;
    }

    return "";
  });

  return {
    text: cleanTelegramText(textWithoutMarkers),
    requests,
    skippedFileCount,
  };
}

function readAgentMessagePhase(value: unknown): AgentMessagePhase | undefined {
  return value === "commentary" || value === "final_answer" ? value : undefined;
}

function readTelegramSendMode(value: string): TelegramSendMode {
  switch (value) {
    case "photo":
      return "photo";
    case "both":
      return "both";
    case "file":
    case "document":
    default:
      return "document";
  }
}
