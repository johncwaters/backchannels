import { env, stderr, stdout } from "node:process";
import { colorDepth, visibleLength } from "./style.js";

const MAX_WIDTH = 84;
const MIN_WIDTH = 40;
const EXIT_CODE_AFTER_INTERRUPT = 130;

export const isAnimated = colorDepth !== "none" && Boolean(stdout.isTTY) && !env.CI;

export function width(): number {
  return Math.max(MIN_WIDTH, Math.min(stdout.columns ?? 80, MAX_WIDTH));
}

export function terminalRows(line: string): number {
  return Math.max(1, Math.ceil(visibleLength(line) / (stdout.columns || MAX_WIDTH)));
}

export function print(line = ""): void {
  stdout.write(`${line}\n`);
}

export function printError(line: string): void {
  stderr.write(`${line}\n`);
}

export function write(text: string): void {
  stdout.write(text);
}

export function rewriteLine(text: string): void {
  stdout.write(`\r\x1b[2K${text}`);
}

export function pause(milliseconds: number): Promise<void> {
  if (!isAnimated) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

let isCursorHidden = false;

function restoreCursorAndExit(): void {
  showCursor();
  process.exit(EXIT_CODE_AFTER_INTERRUPT);
}

export function hideCursor(): void {
  if (!isAnimated || isCursorHidden) return;
  isCursorHidden = true;
  stdout.write("\x1b[?25l");
  process.once("SIGINT", restoreCursorAndExit);
}

export function showCursor(): void {
  if (!isCursorHidden) return;
  isCursorHidden = false;
  stdout.write("\x1b[?25h");
  process.removeListener("SIGINT", restoreCursorAndExit);
}

process.once("exit", showCursor);

export function wrap(text: string, lineWidth: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (current && current.length + 1 + word.length > lineWidth) {
      lines.push(current);
      current = word;
      continue;
    }
    current = current ? `${current} ${word}` : word;
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}
