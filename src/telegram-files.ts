import path from "node:path";
import { makeTimestampedId } from "./runtime.js";

export type TelegramSendMode = "document" | "photo" | "both";

export type TelegramSendRequest = {
  path: string;
  mode: TelegramSendMode;
};

export type ValidatedFile = {
  path: string;
  name: string;
  size: number;
};

export type SavedAttachment = {
  path: string;
  originalName: string;
  mimeType: string | undefined;
  isImage: boolean;
};

export const MAX_FILE_SENDS_PER_TURN = 5;

export function buildSafeAttachmentName(originalName: string, mimeType: string | undefined): string {
  const parsed = path.parse(originalName);
  const base = parsed.name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "attachment";
  const ext = (parsed.ext || extensionForMimeType(mimeType)).replace(/[^a-zA-Z0-9.]/g, "");
  return `${makeTimestampedId(base)}${ext}`;
}

export function isImageAttachment(fileName: string, mimeType: string | undefined): boolean {
  if (mimeType?.startsWith("image/")) {
    return true;
  }

  return [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(path.extname(fileName).toLowerCase());
}

export function formatBytes(bytes: number): string {
  const megabytes = bytes / 1024 / 1024;
  return `${megabytes.toFixed(megabytes >= 10 ? 0 : 1)} MB`;
}

export function expandHome(value: string): string {
  if (value === "~") {
    return process.env.HOME ?? value;
  }

  if (value.startsWith("~/")) {
    const home = process.env.HOME;
    return home ? path.join(home, value.slice(2)) : value;
  }

  return value;
}

export function isPathInside(filePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, filePath);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function isSensitivePath(filePath: string): boolean {
  const normalized = filePath.split(path.sep).map((part) => part.toLowerCase());
  const base = path.basename(filePath).toLowerCase();
  const sensitiveDirectories = new Set([
    ".ssh",
    ".gnupg",
    "keychains",
    "cookies",
    "login data",
    "local state",
    "profiles",
  ]);
  const sensitiveFiles = new Set([
    ".env",
    ".npmrc",
    ".netrc",
    ".git-credentials",
    ".gitconfig",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "known_hosts",
    "authorized_keys",
    "login.keychain-db",
  ]);

  if (normalized.some((part) => sensitiveDirectories.has(part))) {
    return true;
  }

  if (sensitiveFiles.has(base)) {
    return true;
  }

  if (/\b(secret|token|credential|password|passwd|apikey|api-key|private[-_.]?key)\b/i.test(base)) {
    return true;
  }

  return [".pem", ".key", ".p12", ".pfx", ".keystore"].includes(path.extname(base));
}

function extensionForMimeType(mimeType: string | undefined): string {
  switch (mimeType) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "application/pdf":
      return ".pdf";
    case "text/plain":
      return ".txt";
    case "audio/ogg":
    case "audio/oga":
      return ".ogg";
    case "audio/mpeg":
      return ".mp3";
    case "audio/mp4":
      return ".m4a";
    case "audio/wav":
    case "audio/x-wav":
      return ".wav";
    default:
      return "";
  }
}
