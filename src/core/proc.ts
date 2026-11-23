import { spawn } from "node:child_process";

export interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command and returns what it printed. A missing program returns code 127. */
export function capture(command: string, args: string[], options: { cwd?: string; env?: Record<string, string> } = {}): Promise<Captured> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? (process.env as Record<string, string>), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => resolve({ code: 127, stdout, stderr: error.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/**
 * Runs a command with its output sent to our stderr, so our stdout stays one
 * JSON document. `inheritStdout` hands the child our real stdout (exec).
 */
export function stream(command: string, args: string[], options: { cwd?: string; env?: Record<string, string>; inheritStdout?: boolean } = {}): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? (process.env as Record<string, string>),
      stdio: [options.inheritStdout ? "inherit" : "ignore", options.inheritStdout ? "inherit" : 2, 2],
    });
    child.on("error", (error) => {
      process.stderr.write(`${command}: ${error.message}\n`);
      resolve(127);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}
