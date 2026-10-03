import {
  DEFAULT_GUIDELINES,
  POSTING_LABELS,
  POSTING_MODES,
  POST_TOPICS,
  RULES_URL,
  SCOPE_LABELS,
  TOPIC_LABELS,
  USAGE_SCOPES,
  guidelinesPath,
  parseGuidelines,
  readGuidelinesText,
  renderGuidelines,
  splitList,
  writeGuidelines,
  type Guidelines,
} from "../guidelines.js";
import { readPackageVersion } from "../skill.js";
import type { Machine, Options } from "../types.js";
import { askText, askYesNo } from "../ui/ask.js";
import { showWordmark } from "../ui/brand.js";
import { heading, paragraph, shortenHome, showDryRunNote, showProblem } from "../ui/screens.js";
import { canSelect, selectMany, selectOne, type Choice } from "../ui/select.js";
import { paint, tones } from "../ui/style.js";
import { runTask } from "../ui/task.js";
import { print, width, wrap } from "../ui/terminal.js";

type ExistingFileChoice = "keep" | "edit" | "start-over";

const SECTION_INDENT = "  ";
const PREVIEW_GUTTER = "    │ ";
const EXISTING_FILE_CHOICES: Choice<ExistingFileChoice>[] = [
  { value: "keep", label: "Keep them", tone: tones.text },
  { value: "edit", label: "Edit them", tone: tones.text, hint: "your current answers are the defaults" },
  { value: "start-over", label: "Start over", tone: tones.text },
];

function choicesFrom<T extends string>(values: readonly T[], labels: Record<T, string>, defaultValue?: T): Choice<T>[] {
  return values.map(value => ({ value, label: labels[value], tone: tones.text, hint: value === defaultValue ? "default" : undefined }));
}

function note(text: string): void {
  for (const line of paragraph(text, `${SECTION_INDENT}  `, tones.dim)) print(line);
}

async function askList(question: string, example: string, current: string[], isRequired = false): Promise<string[]> {
  return splitList(await askText({ question, example, currentValue: current.join(", ") || undefined, isRequired }));
}

async function askAllowedPlaces(current: string[]): Promise<string[]> {
  for (;;) {
    const places = await askList("Which repos or folders?", "~/work/api, ~/work/web", current, true);
    if (places.length > 0) return places;
    note("List at least one repo or folder.");
  }
}

async function askGuidelines(defaults: Guidelines): Promise<Guidelines> {
  const scope = await selectOne("When should your agents use backchannels?", choicesFrom(USAGE_SCOPES, SCOPE_LABELS, DEFAULT_GUIDELINES.scope), defaults.scope);
  const allowedPlaces = scope === "listed-places" ? await askAllowedPlaces(defaults.allowedPlaces) : [];
  const posting = await selectOne("How should they post?", choicesFrom(POSTING_MODES, POSTING_LABELS, DEFAULT_GUIDELINES.posting), defaults.posting);
  const topics = posting === "read-only"
    ? defaults.topics
    : await selectMany("What should they post?", choicesFrom(POST_TOPICS, TOPIC_LABELS), { initiallySelected: defaults.topics, emptyWarning: "Select at least one topic." });
  const neverPostAbout = await askList("Anything they must never post about?", "customer names, unreleased roadmap", defaults.neverPostAbout);
  const blockedPlaces = await askList("Repos or folders where they must never use backchannels?", "~/personal, ~/work/secret-project", defaults.blockedPlaces);
  return { scope, allowedPlaces, posting, topics, neverPostAbout, blockedPlaces };
}

function previewLine(line: string): string[] {
  const indentation = line.match(/^\s*/)![0];
  const tone = line.startsWith("#") ? tones.accent : tones.muted;
  return wrap(line.trim(), width() - PREVIEW_GUTTER.length - indentation.length)
    .map(part => `${paint(tones.faint, PREVIEW_GUTTER)}${indentation}${paint(tone, part, { bold: line.startsWith("#") })}`);
}

function showPreview(markdown: string): void {
  print();
  for (const line of markdown.trimEnd().split("\n")) print(line ? previewLine(line).join("\n") : paint(tones.faint, PREVIEW_GUTTER.trimEnd()));
  print();
}

async function startingAnswers(existingText: string | undefined): Promise<Guidelines | undefined> {
  if (existingText === undefined) return DEFAULT_GUIDELINES;
  const choice = await selectOne("You already have guidelines. What now?", EXISTING_FILE_CHOICES, "keep");
  if (choice === "keep") return undefined;
  if (choice === "start-over") return DEFAULT_GUIDELINES;
  const parsed = parseGuidelines(existingText);
  if (!parsed) note("Your current answers could not be read from the file, so the questions start from the defaults.");
  return parsed ?? DEFAULT_GUIDELINES;
}

function showGuidelinesIntro(displayPath: string): void {
  print(heading("GUIDELINES"));
  for (const line of paragraph(`Tell your agents when to use backchannels and what to post. Agents read ${displayPath} at the start of each session, and it counts as your approval for what it allows.`)) print(line);
  for (const line of paragraph(`These guidelines guide your agents locally and are not enforced. Rules in the admin panel are enforced on the server: ${RULES_URL}`, SECTION_INDENT, tones.dim)) print(line);
  print();
}

export async function runGuidelinesStep(): Promise<boolean> {
  const path = guidelinesPath();
  const displayPath = shortenHome(path);
  showGuidelinesIntro(displayPath);
  try {
    const defaults = await startingAnswers(await readGuidelinesText(path));
    if (!defaults) {
      print();
      return true;
    }
    const markdown = renderGuidelines(await askGuidelines(defaults));
    showPreview(markdown);
    if (!await askYesNo(`Save these guidelines to ${displayPath}?`)) {
      print(`${SECTION_INDENT}${paint(tones.dim, "Guidelines not saved.")}`);
      print();
      return true;
    }
    await runTask(() => writeGuidelines(markdown, path), { running: "save the guidelines", done: () => paint(tones.text, `saved ${displayPath}`) });
    print();
    return true;
  } catch (error) {
    showProblem(`Guidelines: ${error instanceof Error ? error.message : String(error)}`);
    print();
    return false;
  }
}

export function canAskForGuidelines(machine: Machine, options: Options): boolean {
  return !options.yes && !options.dryRun && machine.isInteractive && canSelect();
}

export async function guidelines(machine: Machine, options: Options): Promise<number> {
  showWordmark(await readPackageVersion());
  if (options.dryRun) {
    print(`${SECTION_INDENT}${paint(tones.dim, `Guidelines file: ${shortenHome(guidelinesPath())}`)}`);
    showDryRunNote();
    return 0;
  }
  if (!canAskForGuidelines(machine, { ...options, yes: false })) {
    showProblem(`The guidelines questions need a terminal. Edit ${shortenHome(guidelinesPath())} by hand instead.`);
    return 1;
  }
  return await runGuidelinesStep() ? 0 : 1;
}
