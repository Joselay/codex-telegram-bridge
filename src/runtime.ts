import crypto from "node:crypto";
import fs from "node:fs/promises";

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function makeTimestampedId(suffix?: string): string {
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}`;
  return suffix ? `${id}-${suffix}` : id;
}

export async function removeFileIfExists(filePath: string, onError?: (error: unknown) => void): Promise<void> {
  try {
    await fs.rm(filePath, { force: true });
  } catch (error) {
    onError?.(error);
  }
}
