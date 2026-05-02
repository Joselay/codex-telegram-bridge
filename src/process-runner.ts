import { spawn } from "node:child_process";

export type CommandResult = {
  stdout: string;
  stderr: string;
};

type RunCommandOptions = {
  cwd?: string;
};

export function runCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      callback();
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      settle(() => {
        reject(new Error(`${command} timed out`));
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });

    child.on("error", (error) => {
      settle(() => {
        reject(error);
      });
    });

    child.on("close", (code, signal) => {
      settle(() => {
        const stdoutText = Buffer.concat(stdout).toString("utf8");
        const stderrText = Buffer.concat(stderr).toString("utf8");

        if (code !== 0) {
          reject(new Error(`${command} failed: ${stderrText.trim() || `code=${code} signal=${signal ?? "none"}`}`));
          return;
        }

        resolve({ stdout: stdoutText, stderr: stderrText });
      });
    });
  });
}
