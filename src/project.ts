import path from "node:path";
import { runCommand } from "./process-runner.js";

const GIT_ROOT_TIMEOUT_MS = 10 * 1000;

export async function resolveProjectRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await runCommand("git", ["rev-parse", "--show-toplevel"], GIT_ROOT_TIMEOUT_MS, { cwd });
    const root = stdout.trim();
    return root ? root : path.resolve(cwd);
  } catch {
    return path.resolve(cwd);
  }
}
