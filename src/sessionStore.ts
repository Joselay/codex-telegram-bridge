import fs from "node:fs/promises";
import path from "node:path";
import type { StoreFile, ThreadRecord } from "./types.js";

export class SessionStore {
  constructor(private readonly filePath: string) {}

  async get(projectRoot: string): Promise<ThreadRecord | undefined> {
    const store = await this.read();
    return store.projects[projectRoot];
  }

  async set(projectRoot: string, record: ThreadRecord): Promise<void> {
    const store = await this.read();
    store.projects[projectRoot] = record;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  }

  private async read(): Promise<StoreFile> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as StoreFile;
      if (parsed.version === 1 && parsed.projects && typeof parsed.projects === "object") {
        return parsed;
      }
    } catch {
      // Fall through to a fresh store.
    }

    return { version: 1, projects: {} };
  }
}
