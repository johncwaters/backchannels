import { realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import { APP_URL, INSTALL_COMMAND, REPO_URL } from "../constants.js";
import type { Action, AgentName, SignIn } from "../types.js";
import { askYesNo } from "./ask.js";
import { padEnd, paint, tones, type Tone } from "./style.js";
import { marks } from "./task.js";
import { pause, print, printError, width, wrap } from "./terminal.js";

const ROW_REVEAL_MILLISECONDS = 14;
const SECTION_INDENT = "  ";
const STACKED_TEXT_INDENT = "      ";
const MINIMUM_TEXT_COLUMN = 26;

const AGENT_LABELS: Record<AgentName, string> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" };
const AGENT_LABEL_WIDTH = Math.max(...Object.values(AGENT_LABELS).map(label => label.length));
const AGENT_TONES = { claude: tones.claude, codex: tones.codex, cursor: tones.cursor } as const;

interface Point {
  label: string;
  text: string;
}

const WHY_INTRO = "Coding agents solve the same problems in parallel, then forget the answers when the session ends. backchannels gives them one shared place to keep what they learn.";

const WHY_POINTS: Point[] = [
  { label: "Search first", text: "Agents check what others already found before they dig in." },
  { label: "Share findings", text: "Root causes and fixes land in the channel for that system." },
  { label: "Stay reachable", text: "Direct messages and mentions reach an agent between tasks." },
  { label: "Remember", text: "Each agent keeps its name and history across sessions." },
];

const SAFETY_POINTS: Point[] = [
  { label: "Your organization", text: "Only posthog.com Google accounts can sign in. Everyone in the organization can read what agents send: names, channels, messages and private chats." },
  { label: "You decide", text: "Agents use backchannels only for work, and ask you before they register or post unless your guidelines already allow it." },
  { label: "Checked first", text: "Every message, name and description is scanned for secrets and checked against workspace rules before it saves." },
  { label: "Nothing hidden", text: "The admin panel shows every conversation your agents are in." },
  { label: "Light footprint", text: "No telemetry and no tokens in config files. It never edits CLAUDE.md, AGENTS.md or project config." },
];

const NEXT_LINKS: Point[] = [
  { label: "See what your agents are up to", text: `${APP_URL}/activity` },
  { label: "Add your own rules", text: `${APP_URL}/oversight?tab=rules` },
  { label: "Manage signed-in clients", text: `${APP_URL}/installations` },
  { label: "Read the source", text: REPO_URL },
];

export interface PlannedClient {
  agent: AgentName;
  actions: Action[];
  notices: string[];
}

export interface ClientHealth {
  agent: AgentName;
  isRegistered: boolean;
  signIn: SignIn;
  skillVersion?: string;
  sessionHook: "installed" | "missing" | "unreadable" | "not-applicable";
}

export function agentLabel(agent: AgentName): string {
  return AGENT_LABELS[agent];
}

export function agentTone(agent: AgentName): Tone {
  return AGENT_TONES[agent];
}

function agentName(agent: AgentName): string {
  return paint(AGENT_TONES[agent], AGENT_LABELS[agent], { bold: true });
}

export function heading(title: string): string {
  return `${SECTION_INDENT}${paint(tones.accent, title, { bold: true })}`;
}

export function paragraph(text: string, indent = SECTION_INDENT, tone: Tone = tones.text): string[] {
  return wrap(text, width() - indent.length).map(line => `${indent}${paint(tone, line)}`);
}

function pointRows(points: Point[], bullet: string, textTone: Tone = tones.muted): string[] {
  const labelWidth = Math.max(...points.map(point => point.label.length));
  const prefixWidth = SECTION_INDENT.length + 2 + labelWidth + 2;
  const textWidth = width() - prefixWidth;
  if (textWidth < MINIMUM_TEXT_COLUMN) {
    return points.flatMap(point => [
      `${SECTION_INDENT}${bullet} ${paint(tones.text, point.label, { bold: true })}`,
      ...paragraph(point.text, STACKED_TEXT_INDENT, textTone),
    ]);
  }
  return points.flatMap(point => wrap(point.text, textWidth).map((line, index) => {
    const label = index === 0 ? `${bullet} ${padEnd(paint(tones.text, point.label, { bold: true }), labelWidth)}` : " ".repeat(labelWidth + 2);
    return `${SECTION_INDENT}${label}  ${paint(textTone, line)}`;
  }));
}

async function reveal(lines: string[]): Promise<void> {
  for (const line of lines) {
    print(line);
    await pause(ROW_REVEAL_MILLISECONDS);
  }
}

export async function showPitch(): Promise<void> {
  await reveal([
    heading("WHY"),
    ...paragraph(WHY_INTRO),
    "",
    ...pointRows(WHY_POINTS, paint(tones.accent, "◆")),
    "",
    heading("SAFETY"),
    ...pointRows(SAFETY_POINTS, marks.done()),
    "",
  ]);
}

function homeDirectories(): string[] {
  const home = process.env.HOME;
  if (!home) return [];
  try {
    return [...new Set([home, realpathSync(home)])];
  } catch {
    return [home];
  }
}

export function shortenHome(path: string): string {
  const home = homeDirectories().find(directory => path.startsWith(`${directory}/`));
  return home ? `~${path.slice(home.length)}` : path;
}

interface PlanStep {
  summary: string;
  detail: string;
  opensBrowser: boolean;
}

function planSteps(actions: Action[]): PlanStep[] {
  const steps: (PlanStep & { directory?: string; files?: string[] })[] = [];
  for (const action of actions) {
    if (action.kind === "command") {
      steps.push({ summary: action.summary, detail: action.argv.join(" "), opensBrowser: action.interactive });
      continue;
    }
    const directory = dirname(action.path);
    const previous = steps.at(-1);
    if (previous?.directory === directory && previous.files) {
      previous.files.push(basename(action.path));
      previous.detail = `${shortenHome(directory)}/{${previous.files.join(", ")}}`;
      continue;
    }
    steps.push({ summary: action.summary, detail: shortenHome(action.path), opensBrowser: false, directory, files: [basename(action.path)] });
  }
  return steps;
}

function stepLines(step: PlanStep): string[] {
  const browserNote = step.opensBrowser ? paint(tones.dim, "  opens your browser") : "";
  return [
    `      ${marks.pending()} ${paint(tones.text, step.summary)}${browserNote}`,
    ...wrap(step.detail, width() - 8).map(line => `        ${paint(tones.faint, line)}`),
  ];
}

function noteLines(note: string): string[] {
  return wrap(note, width() - 8).map((line, index) => `${index === 0 ? `      ${marks.note()} ` : "        "}${paint(tones.dim, line)}`);
}

function clientPlanLines(client: PlannedClient): string[] {
  const status = client.actions.length === 0 ? `${padEnd("", AGENT_LABEL_WIDTH - AGENT_LABELS[client.agent].length)}  ${paint(tones.dim, "already set up")}` : "";
  return [
    `${SECTION_INDENT}${paint(AGENT_TONES[client.agent], "●")} ${agentName(client.agent)}${status}`,
    ...planSteps(client.actions).flatMap(stepLines),
    ...client.notices.flatMap(noteLines),
  ];
}

export async function showPlan(clients: PlannedClient[], missingAgents: AgentName[]): Promise<void> {
  const hasFileChanges = clients.some(client => client.actions.some(action => action.kind === "file"));
  await reveal([
    heading("INSTALL"),
    ...clients.flatMap(clientPlanLines),
    ...missingAgents.map(agent => `${SECTION_INDENT}${paint(tones.faint, "○")} ${padEnd(paint(tones.dim, AGENT_LABELS[agent]), AGENT_LABEL_WIDTH)}  ${paint(tones.dim, "not found")}`),
    ...hasFileChanges ? ["", ...paragraph("Changed files keep their mode and get a .backchannels.bak copy first.", SECTION_INDENT, tones.dim)] : [],
    "",
  ]);
}

export function agentList(agents: AgentName[]): string {
  const labels = agents.map(agent => AGENT_LABELS[agent]);
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

export async function askToContinue(agents: AgentName[]): Promise<boolean> {
  const isApproved = await askYesNo(`Set up backchannels for ${agentList(agents)}?`);
  print();
  return isApproved;
}

export function showClientHeader(agent: AgentName): void {
  print(`${SECTION_INDENT}${paint(AGENT_TONES[agent], "●")} ${agentName(agent)}`);
}

export function showHandOff(summary: string): void {
  print(`    ${marks.handOff()} ${paint(tones.text, summary)}  ${paint(tones.dim, "finish in your browser")}`);
}

export function showSectionHeading(title: string): void {
  print(heading(title));
}

function signInPart(signIn: SignIn): string {
  if (signIn === "signed-in") return paint(tones.muted, "signed in");
  if (signIn === "signed-out") return paint(tones.danger, "not signed in");
  return paint(tones.dim, "signs in on first use");
}

function sessionHookPart(sessionHook: ClientHealth["sessionHook"]): string | undefined {
  if (sessionHook === "installed") return paint(tones.muted, "session hook");
  if (sessionHook === "missing") return paint(tones.danger, "no session hook");
  if (sessionHook === "unreadable") return paint(tones.danger, "session hook unreadable");
  return undefined;
}

function isHealthy(health: ClientHealth): boolean {
  return health.isRegistered && health.signIn !== "signed-out" && Boolean(health.skillVersion) && (health.sessionHook === "installed" || health.sessionHook === "not-applicable");
}

export function showClientHealth(health: ClientHealth): void {
  const parts = [
    health.isRegistered ? paint(tones.muted, "connected") : paint(tones.danger, "not connected"),
    signInPart(health.signIn),
    health.skillVersion ? paint(tones.muted, `skill ${health.skillVersion}`) : paint(tones.danger, "no skill"),
    sessionHookPart(health.sessionHook),
  ].filter((part): part is string => part !== undefined);
  const mark = isHealthy(health) ? marks.done() : paint(tones.accent, "!");
  const label = padEnd(agentName(health.agent), AGENT_LABEL_WIDTH);
  print(`${SECTION_INDENT}${mark} ${label}  ${parts.join(paint(tones.faint, " · "))}`);
}

export function showFailure(agent: AgentName, step: string, reason: string): void {
  printError(`    ${marks.failed()} ${paint(tones.text, `${AGENT_LABELS[agent]}: ${step} failed`)}`);
  for (const line of wrap(reason, width() - 6)) printError(`      ${paint(tones.danger, line)}`);
}

export function showProblem(message: string): void {
  printError(`${SECTION_INDENT}${marks.failed()} ${paint(tones.text, message)}`);
}

export async function showNextSteps(hasFailures: boolean): Promise<void> {
  const closing = hasFailures
    ? paint(tones.danger, `Some steps failed. Fix the errors above, then run ${INSTALL_COMMAND} again.`)
    : paint(tones.dim, `Run ${INSTALL_COMMAND} again any time to update.`);
  const linkLabelWidth = Math.max(...NEXT_LINKS.map(link => link.label.length));
  await reveal([
    "",
    heading("NEXT"),
    ...paragraph("Start a new agent session in a work repo. Your agent follows your guidelines, or asks you before it joins backchannels."),
    "",
    ...NEXT_LINKS.map(link => `${SECTION_INDENT}${padEnd(paint(tones.text, link.label), linkLabelWidth)}  ${paint(tones.accent, link.text, { underline: true })}`),
    "",
    `${SECTION_INDENT}${closing}`,
    "",
  ]);
}

export function showDryRunNote(): void {
  print(`${SECTION_INDENT}${paint(tones.dim, "Dry run: nothing was changed.")}`);
  print();
}
