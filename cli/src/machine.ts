import { execFile, spawn } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import type { Machine } from "./types.js";

export function createMachine(): Machine {
  const isRemote = Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY);
  const hasDisplay = process.platform !== "linux" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  return { isInteractive: Boolean(process.stdin.isTTY), canOpenBrowser: !isRemote && hasDisplay };
}

export function homePath(...parts: string[]): string {
  if (!process.env.HOME) throw new Error("HOME must be set.");
  return join(process.env.HOME, ...parts);
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

export async function hasCommand(command: string): Promise<boolean> {
  for (const directory of (process.env.PATH || "").split(delimiter)) {
    const path = join(directory || ".", command);
    try {
      await access(path, constants.X_OK);
      if ((await stat(path)).isFile()) return true;
    } catch (error) {
      if (["ENOENT", "EACCES", "ENOTDIR", "ELOOP"].some(code => hasErrorCode(error, code))) continue;
      throw error;
    }
  }
  return false;
}

export interface CommandOutput {
  code: number;
  stdout: string;
  stderr: string;
}

const TERMINAL_STYLING = /\x1b\[[0-9;?]*[A-Za-z]/g;

function withoutTerminalStyling(output: string): string {
  return output.replace(TERMINAL_STYLING, "");
}

export async function run(argv: string[], interactive = false): Promise<CommandOutput> {
  const [command, ...arguments_] = argv;
  if (!command) throw new Error("Command must not be empty.");
  if (interactive) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, arguments_, { stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code: code ?? 1, stdout: "", stderr: signal || "" }));
    });
  }
  return new Promise((resolve, reject) => {
    execFile(command, arguments_, { timeout: 30_000, maxBuffer: 1024 * 1024, encoding: "utf8" }, (error, rawStdout, rawStderr) => {
      const stdout = withoutTerminalStyling(rawStdout);
      const stderr = withoutTerminalStyling(rawStderr);
      if (!error) return resolve({ code: 0, stdout, stderr });
      if (typeof error.code === "number") return resolve({ code: error.code, stdout, stderr });
      reject(error);
    });
  });
}

export async function supportsCommands(command: string, operations: string[]): Promise<boolean> {
  for (const operation of operations) {
    if ((await run([command, "mcp", operation, "--help"])).code !== 0) return false;
  }
  return true;
}

export function isMissingServer(output: CommandOutput): boolean {
  if (output.code !== 1) return false;
  return /^(?:Error:\s*)?No MCP server named ["']?backchannels\b/im.test(output.stdout + "\n" + output.stderr);
}

export function requireSuccess(output: CommandOutput, description: string): void {
  if (output.code !== 0) throw new Error(`${description} failed (exit ${output.code}).`);
}
