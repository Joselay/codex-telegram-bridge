import { spawn, type ChildProcessByStdio } from "node:child_process";
import fs from "node:fs";
import type { Readable, Writable } from "node:stream";
import readline from "node:readline";
import { EventEmitter } from "node:events";
import type { ConfigReasoningLevel, ReasoningLevel } from "./config.js";
import type { JsonRpcMessage, JsonRpcResponse } from "./types.js";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export type CodexModel = {
  id: string;
  defaultReasoningEffort?: ReasoningLevel;
  supportedReasoningEfforts?: Array<{ reasoningEffort?: ReasoningLevel }>;
};

export class CodexClient extends EventEmitter {
  private proc: ChildProcessByStdio<Writable, Readable, Readable> | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  async start(): Promise<void> {
    const proc = spawn("codex", ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;

    const stderrLog = fs.createWriteStream("codex-app-server.log", { flags: "a", mode: 0o600 });
    stderrLog.write(`\n--- codex app-server started ${new Date().toISOString()} ---\n`);
    proc.stderr.pipe(stderrLog);

    const rl = readline.createInterface({ input: proc.stdout });
    rl.on("line", (line) => this.handleLine(line));

    proc.on("exit", (code, signal) => {
      this.emit("exit", { code, signal });
      for (const [id, pending] of this.pending) {
        pending.reject(new Error(`codex app-server exited before request ${id} completed`));
      }
      this.pending.clear();
    });

    await this.request("initialize", {
      clientInfo: {
        name: "codex_telegram_bridge",
        title: "Codex Telegram Bridge",
        version: "0.1.0",
      },
    });
    this.notify("initialized", {});
  }

  async startThread(cwd: string, model: string, reasoningLevel: ReasoningLevel): Promise<string> {
    const result = await this.request("thread/start", {
      cwd,
      model,
      config: toThreadConfig(reasoningLevel),
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      serviceName: "codex_telegram_bridge",
    });
    return getThreadId(result);
  }

  async resumeThread(threadId: string, model: string, reasoningLevel: ReasoningLevel): Promise<string> {
    const result = await this.request("thread/resume", {
      threadId,
      model,
      config: toThreadConfig(reasoningLevel),
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    return getThreadId(result);
  }

  async listModels(): Promise<CodexModel[]> {
    const result = await this.request("model/list", { includeHidden: true });
    const data = (result as { data?: unknown })?.data;
    return Array.isArray(data) ? data.filter(isCodexModel) : [];
  }

  async startTurn(
    threadId: string,
    text: string,
    cwd: string,
    reasoningLevel: ReasoningLevel,
  ): Promise<string | undefined> {
    const result = await this.request("turn/start", {
      threadId,
      cwd,
      effort: reasoningLevel,
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      input: [{ type: "text", text }],
    });

    return getTurnId(result);
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId, turnId });
  }

  stop(): void {
    this.proc?.kill("SIGTERM");
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    this.send({ method, id, params });

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  private notify(method: string, params?: unknown): void {
    this.send({ method, params });
  }

  private send(message: { method: string; id?: number; params?: unknown }): void {
    if (!this.proc) {
      throw new Error("codex app-server is not running");
    }

    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.emit("notification", { method: "raw", params: { line } });
      return;
    }

    if ("id" in message && typeof message.id === "number") {
      this.handleResponse(message);
      return;
    }

    this.emit("notification", message);
  }

  private handleResponse(response: JsonRpcResponse): void {
    if (typeof response.id !== "number") {
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }

    this.pending.delete(response.id);

    if (response.error) {
      pending.reject(new Error(response.error.message));
      return;
    }

    pending.resolve(response.result);
  }
}

function getThreadId(result: unknown): string {
  const threadId = (result as { thread?: { id?: unknown } })?.thread?.id;
  if (typeof threadId !== "string") {
    throw new Error("Codex response did not include thread.id");
  }
  return threadId;
}

function getTurnId(result: unknown): string | undefined {
  const turnId = (result as { turn?: { id?: unknown } })?.turn?.id;
  return typeof turnId === "string" ? turnId : undefined;
}

function toThreadConfig(reasoningLevel: ReasoningLevel): { model_reasoning_effort: ConfigReasoningLevel } | undefined {
  return reasoningLevel === "none" ? undefined : { model_reasoning_effort: reasoningLevel };
}

function isCodexModel(value: unknown): value is CodexModel {
  return typeof (value as { id?: unknown })?.id === "string";
}
