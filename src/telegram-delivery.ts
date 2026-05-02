import fs from "node:fs/promises";
import path from "node:path";
import type { Telegraf } from "telegraf";
import { formatError, removeFileIfExists } from "./runtime.js";
import {
  expandHome,
  formatBytes,
  isImageAttachment,
  isPathInside,
  isSensitivePath,
} from "./telegram-files.js";
import type { TelegramSendRequest, ValidatedFile } from "./telegram-files.js";
import { sendLongTelegramMessage } from "./telegram-message.js";

type TelegramApi = Telegraf["telegram"];

type TelegramFileDeliveryOptions = {
  telegram: TelegramApi;
  allowedUserId: number;
  temporaryRoot: string;
  fileSendRoots: string[];
  fileSendMaxBytes: number;
};

const MAX_PHOTO_SEND_BYTES = 10 * 1024 * 1024;

export class TelegramFileDelivery {
  private readonly turnTempFiles = new Set<string>();

  constructor(private readonly options: TelegramFileDeliveryOptions) {}

  trackTurnTempFile(filePath: string): void {
    this.turnTempFiles.add(filePath);
  }

  clearTrackedTurnTempFiles(): void {
    this.turnTempFiles.clear();
  }

  async cleanupTurnTempFiles(): Promise<void> {
    const filePaths = [...this.turnTempFiles];
    this.turnTempFiles.clear();
    await Promise.all(filePaths.map((filePath) => this.removeTemporaryFileIfManaged(filePath)));
  }

  async removeTemporaryFileIfManaged(filePath: string): Promise<void> {
    if (!isPathInside(path.resolve(filePath), path.resolve(this.options.temporaryRoot))) {
      return;
    }

    await removeIfExists(filePath);
    await removeEmptyParents(path.dirname(filePath), this.options.temporaryRoot);
  }

  async sendRequestedFile(request: TelegramSendRequest): Promise<void> {
    let file: ValidatedFile;
    try {
      file = await this.validateRequestedFile(request.path);
    } catch (error) {
      await this.sendLongMessage(`Could not send ${request.mode} "${request.path}": ${formatError(error)}`);
      return;
    }

    if (request.mode === "photo") {
      try {
        await this.sendPhotoFile(file);
        await this.removeTemporaryFileIfManaged(file.path);
      } catch (error) {
        await this.sendLongMessage(`Could not send photo "${request.path}": ${formatError(error)}`);
      }
      return;
    }

    if (request.mode === "both") {
      try {
        await this.sendPhotoFile(file);
      } catch (error) {
        await this.sendLongMessage(`Could not send photo preview "${request.path}": ${formatError(error)}`);
      }
    }

    try {
      await this.sendDocumentFile(file);
      await this.removeTemporaryFileIfManaged(file.path);
    } catch (error) {
      await this.sendLongMessage(`Could not send document "${request.path}": ${formatError(error)}`);
    }
  }

  private async sendLongMessage(text: string): Promise<void> {
    await sendLongTelegramMessage(this.options.telegram, this.options.allowedUserId, text);
  }

  private async sendDocumentFile(file: ValidatedFile): Promise<void> {
    await this.options.telegram.sendChatAction(this.options.allowedUserId, "upload_document");
    await this.options.telegram.sendDocument(
      this.options.allowedUserId,
      { source: file.path, filename: file.name },
      { caption: file.name },
    );
  }

  private async sendPhotoFile(file: ValidatedFile): Promise<void> {
    if (!isImageAttachment(file.name, undefined)) {
      throw new Error("sendPhoto supports image files only");
    }

    if (file.size > MAX_PHOTO_SEND_BYTES) {
      throw new Error(`photo is too large for Telegram sendPhoto. Limit: ${formatBytes(MAX_PHOTO_SEND_BYTES)}`);
    }

    await this.options.telegram.sendChatAction(this.options.allowedUserId, "upload_photo");
    await this.options.telegram.sendPhoto(
      this.options.allowedUserId,
      { source: file.path, filename: file.name },
      { caption: file.name },
    );
  }

  private async validateRequestedFile(requestedPath: string): Promise<ValidatedFile> {
    const expandedPath = expandHome(requestedPath.trim());
    if (!path.isAbsolute(expandedPath)) {
      throw new Error("file marker must use an absolute path");
    }

    const absolutePath = path.resolve(expandedPath);
    const realPath = await fs.realpath(absolutePath);
    const stat = await fs.stat(realPath);

    if (!stat.isFile()) {
      throw new Error("path is not a regular file");
    }

    if (stat.size > this.options.fileSendMaxBytes) {
      throw new Error(`file is too large. Limit: ${formatBytes(this.options.fileSendMaxBytes)}`);
    }

    if (!(await this.isInsideAllowedSendRoot(realPath))) {
      throw new Error(`file is outside allowed upload roots (${this.options.fileSendRoots.join(", ")})`);
    }

    if (isSensitivePath(realPath)) {
      throw new Error("file path looks sensitive and is blocked");
    }

    return {
      path: realPath,
      name: path.basename(realPath),
      size: stat.size,
    };
  }

  private async isInsideAllowedSendRoot(realPath: string): Promise<boolean> {
    const realTemporaryRoot = await fs.realpath(this.options.temporaryRoot);
    if (isPathInside(realPath, realTemporaryRoot)) {
      return true;
    }

    for (const root of this.options.fileSendRoots) {
      let realRoot: string;
      try {
        realRoot = await fs.realpath(root);
      } catch {
        continue;
      }

      if (isPathInside(realPath, realRoot)) {
        return true;
      }
    }

    return false;
  }
}

async function removeIfExists(filePath: string): Promise<void> {
  await removeFileIfExists(filePath, (error) => {
    console.error(`Temporary file cleanup error: ${formatError(error)}`);
  });
}

async function removeEmptyParents(directory: string, stopDirectory: string): Promise<void> {
  let current = path.resolve(directory);
  const stop = path.resolve(stopDirectory);

  while (current !== stop && isPathInside(current, stop)) {
    try {
      await fs.rmdir(current);
    } catch {
      return;
    }

    current = path.dirname(current);
  }
}
