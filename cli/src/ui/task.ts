import { paint, tones } from "./style.js";
import { hideCursor, isAnimated, print, rewriteLine, showCursor } from "./terminal.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MILLISECONDS = 80;
const MINIMUM_VISIBLE_MILLISECONDS = 240;

export const marks = {
  done: () => paint(tones.success, "✓"),
  failed: () => paint(tones.danger, "✗"),
  pending: () => paint(tones.accent, "◇"),
  handOff: () => paint(tones.accent, "↗"),
  note: () => paint(tones.dim, "›"),
};

interface TaskLabels<T> {
  running: string;
  done: (result: T) => string;
  indent?: string;
}

function spinnerFrame(index: number): string {
  return paint(tones.accent, SPINNER_FRAMES[index % SPINNER_FRAMES.length]!);
}

async function holdUntilVisible(startedAt: number): Promise<void> {
  const remaining = MINIMUM_VISIBLE_MILLISECONDS - (Date.now() - startedAt);
  if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
}

export async function runTask<T>(work: () => Promise<T>, { running, done, indent = "  " }: TaskLabels<T>): Promise<T> {
  if (!isAnimated) {
    try {
      const result = await work();
      print(`${indent}${marks.done()} ${done(result)}`);
      return result;
    } catch (error) {
      print(`${indent}${marks.failed()} ${running}`);
      throw error;
    }
  }
  hideCursor();
  const startedAt = Date.now();
  let frame = 0;
  const render = () => rewriteLine(`${indent}${spinnerFrame(frame++)} ${paint(tones.text, running)}`);
  render();
  const timer = setInterval(render, FRAME_MILLISECONDS);
  try {
    const result = await work();
    await holdUntilVisible(startedAt);
    clearInterval(timer);
    rewriteLine(`${indent}${marks.done()} ${done(result)}\n`);
    return result;
  } catch (error) {
    clearInterval(timer);
    rewriteLine(`${indent}${marks.failed()} ${paint(tones.text, running)}\n`);
    throw error;
  } finally {
    clearInterval(timer);
    showCursor();
  }
}
