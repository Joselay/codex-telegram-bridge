import fs from "node:fs/promises";
import path from "node:path";
import type { Telegraf } from "telegraf";
import type { CodexInputItem } from "./codex-client.js";
import { buildSafeAttachmentName, formatBytes, isImageAttachment } from "./telegram-files.js";
import type { SavedAttachment } from "./telegram-files.js";

type TelegramApi = Telegraf["telegram"];

type TelegramAttachmentServiceOptions = {
  telegram: TelegramApi;
  temporaryRoot: string;
  supportsImageInput: boolean;
};

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const ATTACHMENT_DIR = "attachments";

export class TelegramAttachmentService {
  constructor(private readonly options: TelegramAttachmentServiceOptions) {}

  async download(fileId: string, originalName: string, mimeType: string | undefined): Promise<SavedAttachment> {
    const link = await this.options.telegram.getFileLink(fileId);
    const response = await fetch(link);
    if (!response.ok) {
      throw new Error(`Telegram download failed: ${response.status} ${response.statusText}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Attachment is too large. Limit: ${formatBytes(MAX_ATTACHMENT_BYTES)}.`);
    }

    const directory = path.join(this.options.temporaryRoot, ATTACHMENT_DIR);
    const safeName = buildSafeAttachmentName(originalName, mimeType);
    const filePath = path.join(directory, safeName);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(filePath, buffer, { mode: 0o600 });

    return {
      path: filePath,
      originalName,
      mimeType,
      isImage: isImageAttachment(originalName, mimeType),
    };
  }

  buildCodexInput(attachment: SavedAttachment, caption: string | undefined): CodexInputItem[] {
    const text = [
      `User sent a Telegram attachment saved at: ${attachment.path}`,
      `Original filename: ${attachment.originalName}`,
      `MIME type: ${attachment.mimeType ?? "unknown"}`,
      caption?.trim() ? `Caption: ${caption.trim()}` : undefined,
      attachment.isImage
        ? "Inspect the attached image and respond to the user's request."
        : "Inspect the local file path above and respond to the user's request.",
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");

    if (attachment.isImage && this.options.supportsImageInput) {
      return [
        { type: "text", text },
        { type: "localImage", path: attachment.path },
      ];
    }

    if (attachment.isImage) {
      return [
        {
          type: "text",
          text: `${text}\n\nNote: the selected Codex model does not advertise image input support, so use the saved file path if possible.`,
        },
      ];
    }

    return [{ type: "text", text }];
  }
}
