import { emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";
import { paint, tones, type Tone } from "./style.js";
import { hideCursor, showCursor, terminalRows } from "./terminal.js";

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

const MANY_HELP = "↑↓ move · space toggle · a all · enter confirm";
const ONE_HELP = "↑↓ move · enter confirm";

function questionLine(question: string): string {
  return `${INDENT}${paint(tones.accent, "?", { bold: true })} ${paint(tones.text, question, { bold: true })}`;
}

function footerLine(help: string, warning: string): string {
  return `${INDENT}  ${warning ? paint(tones.danger, warning) : paint(tones.faint, help)}`;
}

function renderSummary<T>(question: string, picked: Choice<T>[]): string {
  const labels = picked.map(choice => paint(choice.tone, choice.label)).join(paint(tones.faint, ", "));
  return `${INDENT}${paint(tones.success, "✓")} ${paint(tones.text, question, { bold: true })} ${labels}`;
}

interface KeyPrompt<R> {
  render: () => string[];
  summary: () => string;
  onKey: (key: Keypress) => { result: R } | undefined;
}

function runKeyPrompt<R>(prompt: KeyPrompt<R>): Promise<R> {
  let renderedRowCount = 0;
  const draw = (lines: string[]) => {
    if (renderedRowCount > 0) stdout.write(`\x1b[${renderedRowCount}F`);
    stdout.write(`\x1b[J${lines.join("\n")}\n`);
    renderedRowCount = lines.reduce((rows, line) => rows + terminalRows(line), 0);
  };

  return new Promise(resolve => {
    const wasRaw = stdin.isRaw;
    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    hideCursor();

    const onKeypress = (_input: string, key: Keypress = {}) => {
      if (key.ctrl && key.name === "c") {
        stdin.setRawMode(wasRaw);
        showCursor();
        stdout.write("\n");
        process.exit(EXIT_CODE_AFTER_INTERRUPT);
      }
      const outcome = prompt.onKey(key);
      if (!outcome) return draw(prompt.render());
      stdin.removeListener("keypress", onKeypress);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      draw([prompt.summary()]);
      showCursor();
      resolve(outcome.result);
    };

    stdin.on("keypress", onKeypress);
    draw(prompt.render());
  });
}

function moveFocus(key: Keypress, focus: number, count: number): number {
  if (key.name === "up" || key.name === "k") return (focus - 1 + count) % count;
  if (key.name === "down" || key.name === "j") return (focus + 1) % count;
  return focus;
}

function isConfirmKey(key: Keypress): boolean {
  return key.name === "return" || key.name === "enter";
}

export interface SelectManyOptions<T> {
  initiallySelected?: T[];
  emptyWarning?: string;
}

export function selectMany<T>(question: string, choices: Choice<T>[], options: SelectManyOptions<T> = {}): Promise<T[]> {
  const initial = options.initiallySelected;
  const selected = new Set(choices.flatMap((choice, index) => !initial || initial.includes(choice.value) ? [index] : []));
  const emptyWarning = options.emptyWarning ?? "Select at least one agent.";
  const pickedChoices = () => choices.filter((_, index) => selected.has(index));
  let focus = 0;
  let warning = "";

  return runKeyPrompt({
    render: () => [
      questionLine(question),
      ...choices.map((choice, index) => renderChoice(choice, selected.has(index), index === focus)),
      footerLine(MANY_HELP, warning),
    ],
    summary: () => renderSummary(question, pickedChoices()),
    onKey: key => {
      warning = "";
      focus = moveFocus(key, focus, choices.length);
      if (key.name === "space") {
        if (selected.has(focus)) selected.delete(focus);
        else selected.add(focus);
      } else if (key.name === "a") {
        if (selected.size === choices.length) selected.clear();
        else choices.forEach((_, index) => selected.add(index));
      } else if (isConfirmKey(key)) {
        if (selected.size > 0) return { result: pickedChoices().map(choice => choice.value) };
        warning = emptyWarning;
      }
      return undefined;
    },
  });
}

function renderOption<T>(choice: Choice<T>, isFocused: boolean): string {
  const pointer = isFocused ? paint(tones.accent, "›") : " ";
  const dot = isFocused ? paint(tones.accent, "●") : paint(tones.faint, "○");
  const label = paint(isFocused ? choice.tone : tones.dim, choice.label, { bold: isFocused });
  const hint = choice.hint ? `  ${paint(tones.faint, choice.hint)}` : "";
  return `${INDENT}${pointer} ${dot} ${label}${hint}`;
}

export function selectOne<T>(question: string, choices: Choice<T>[], initialValue?: T): Promise<T> {
  let focus = Math.max(0, choices.findIndex(choice => choice.value === initialValue));
  return runKeyPrompt({
    render: () => [questionLine(question), ...choices.map((choice, index) => renderOption(choice, index === focus)), footerLine(ONE_HELP, "")],
    summary: () => renderSummary(question, [choices[focus]!]),
    onKey: key => {
      focus = moveFocus(key, focus, choices.length);
      return isConfirmKey(key) ? { result: choices[focus]!.value } : undefined;
    },
  });
}
