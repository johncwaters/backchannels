import { emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";
import { paint, tones, type Tone } from "./style.js";
import { hideCursor, showCursor } from "./terminal.js";

export interface Choice<T> {
  value: T;
  label: string;
  tone: Tone;
  hint?: string;
}

interface Keypress {
  name?: string;
  ctrl?: boolean;
}

const EXIT_CODE_AFTER_INTERRUPT = 130;
const INDENT = "  ";

export function canSelect(): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY);
}

function renderChoice<T>(choice: Choice<T>, isSelected: boolean, isFocused: boolean): string {
  const pointer = isFocused ? paint(tones.accent, "›") : " ";
  const box = isSelected ? paint(tones.accent, "◉") : paint(tones.faint, "○");
  const label = paint(isSelected ? choice.tone : tones.dim, choice.label, { bold: isFocused });
  const hint = choice.hint ? `  ${paint(tones.faint, choice.hint)}` : "";
  return `${INDENT}${pointer} ${box} ${label}${hint}`;
}

function renderLines<T>(question: string, choices: Choice<T>[], selected: Set<number>, focus: number, warning: string): string[] {
  return [
    `${INDENT}${paint(tones.accent, "?", { bold: true })} ${paint(tones.text, question, { bold: true })}`,
    ...choices.map((choice, index) => renderChoice(choice, selected.has(index), index === focus)),
    `${INDENT}  ${warning ? paint(tones.danger, warning) : paint(tones.faint, "↑↓ move · space toggle · a all · enter confirm")}`,
  ];
}

function renderSummary<T>(question: string, choices: Choice<T>[], selected: Set<number>): string {
  const picked = choices.filter((_, index) => selected.has(index)).map(choice => paint(choice.tone, choice.label)).join(paint(tones.faint, ", "));
  return `${INDENT}${paint(tones.success, "✓")} ${paint(tones.text, question, { bold: true })} ${picked}`;
}

export function selectMany<T>(question: string, choices: Choice<T>[]): Promise<T[]> {
  const selected = new Set(choices.map((_, index) => index));
  let focus = 0;
  let warning = "";
  let renderedLineCount = 0;

  const draw = (lines: string[]) => {
    if (renderedLineCount > 0) stdout.write(`\x1b[${renderedLineCount}F`);
    stdout.write(`\x1b[J${lines.join("\n")}\n`);
    renderedLineCount = lines.length;
  };

  return new Promise(resolve => {
    const wasRaw = stdin.isRaw;
    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    hideCursor();

    const finish = (values: T[]) => {
      stdin.removeListener("keypress", onKeypress);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      draw([renderSummary(question, choices, selected)]);
      showCursor();
      resolve(values);
    };

    const onKeypress = (_input: string, key: Keypress = {}) => {
      if (key.ctrl && key.name === "c") {
        stdin.setRawMode(wasRaw);
        showCursor();
        stdout.write("\n");
        process.exit(EXIT_CODE_AFTER_INTERRUPT);
      }
      warning = "";
      if (key.name === "up" || key.name === "k") focus = (focus - 1 + choices.length) % choices.length;
      else if (key.name === "down" || key.name === "j") focus = (focus + 1) % choices.length;
      else if (key.name === "space") {
        if (selected.has(focus)) selected.delete(focus);
        else selected.add(focus);
      } else if (key.name === "a") {
        if (selected.size === choices.length) selected.clear();
        else choices.forEach((_, index) => selected.add(index));
      } else if (key.name === "return" || key.name === "enter") {
        if (selected.size > 0) return finish(choices.filter((_, index) => selected.has(index)).map(choice => choice.value));
        warning = "Select at least one agent.";
      }
      draw(renderLines(question, choices, selected, focus, warning));
    };

    stdin.on("keypress", onKeypress);
    draw(renderLines(question, choices, selected, focus, warning));
  });
}
