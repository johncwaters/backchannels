import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { paint, tones } from "./style.js";
import { terminalRows } from "./terminal.js";

const INDENT = "  ";
export const CLEAR_ANSWER = "-";

function questionPrefix(question: string): string {
  return `${INDENT}${paint(tones.accent, "?", { bold: true })} ${paint(tones.text, question, { bold: true })}`;
}

async function ask(prompt: string): Promise<string> {
  const reader = createInterface({ input: stdin, output: stdout });
  try {
    return (await reader.question(prompt)).trim();
  } finally {
    reader.close();
  }
}

export async function askYesNo(question: string): Promise<boolean> {
  const answer = (await ask(`${questionPrefix(question)} ${paint(tones.dim, "[Y/n]")} `)).toLowerCase();
  return answer === "" || answer === "y" || answer === "yes";
}

export interface TextQuestion {
  question: string;
  example?: string;
  currentValue?: string;
  isRequired?: boolean;
}

function textHint({ example, currentValue, isRequired }: TextQuestion): string {
  if (currentValue) return `enter keeps "${currentValue}" · type ${CLEAR_ANSWER} to clear`;
  const exampleText = example ? `e.g. ${example}` : "";
  if (isRequired) return exampleText;
  return [exampleText, "enter skips"].filter(Boolean).join(" · ");
}

function textSummary(question: string, value: string): string {
  return `${INDENT}${paint(tones.success, "✓")} ${paint(tones.text, question, { bold: true })} ${value ? paint(tones.muted, value) : paint(tones.dim, "none")}`;
}

export async function askText(text: TextQuestion): Promise<string> {
  const questionLine = questionPrefix(text.question);
  const hint = textHint(text);
  const hintLines = hint ? [`${INDENT}  ${paint(tones.faint, hint)}`] : [];
  const inputPrompt = `${INDENT}  ${paint(tones.accent, "›")} `;
  stdout.write(`${[questionLine, ...hintLines].join("\n")}\n`);
  const answer = await ask(inputPrompt);
  const value = answer === CLEAR_ANSWER ? "" : answer || text.currentValue || "";
  if (stdout.isTTY) {
    const writtenRows = [questionLine, ...hintLines].reduce((rows, line) => rows + terminalRows(line), 0) + terminalRows(`${inputPrompt}${answer}`);
    stdout.write(`\x1b[${writtenRows}F\x1b[J${textSummary(text.question, value)}\n`);
  }
  return value;
}
