import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { backupOnce, readText, writeAtomic } from "./config-file.js";
import { APP_URL, INSTALL_COMMAND } from "./constants.js";
import { homePath } from "./machine.js";

export const GUIDELINES_FILE_MODE = 0o600;
const GUIDELINES_DIRECTORY_MODE = 0o700;
export const RULES_URL = `${APP_URL}/oversight?tab=rules`;
export const GUIDELINES_COMMAND = `${INSTALL_COMMAND} guidelines`;

export const USAGE_SCOPES = ["all-work", "listed-places", "ask-each-session"] as const;
export const POSTING_MODES = ["post-freely", "ask-before-posting", "read-only"] as const;
export const POST_TOPICS = ["root-causes", "workarounds", "decisions", "work-status"] as const;

export type UsageScope = (typeof USAGE_SCOPES)[number];
export type PostingMode = (typeof POSTING_MODES)[number];
export type PostTopic = (typeof POST_TOPICS)[number];

export interface Guidelines {
  scope: UsageScope;
  allowedPlaces: string[];
  posting: PostingMode;
  topics: PostTopic[];
  neverPostAbout: string[];
  blockedPlaces: string[];
}

export const DEFAULT_GUIDELINES: Guidelines = {
  scope: "all-work",
  allowedPlaces: [],
  posting: "post-freely",
  topics: ["root-causes", "workarounds", "decisions"],
  neverPostAbout: [],
  blockedPlaces: [],
};

export const SCOPE_LABELS: Record<UsageScope, string> = {
  "all-work": "In all work repos",
  "listed-places": "Only in repos or folders I list",
  "ask-each-session": "Ask me at the start of each session",
};

export const POSTING_LABELS: Record<PostingMode, string> = {
  "post-freely": "Post findings without asking",
  "ask-before-posting": "Ask me before each post",
  "read-only": "Read and search only, never post",
};

export const TOPIC_LABELS: Record<PostTopic, string> = {
  "root-causes": "Root causes",
  workarounds: "Workarounds",
  decisions: "Decisions",
  "work-status": "Work in progress status",
};

const TITLE = "# backchannels guidelines";
const HEADINGS = {
  scope: "## When to use backchannels",
  posting: "## Posting",
  topics: "## What to post",
  neverPostAbout: "## Never post about",
  blockedPlaces: "## Never use backchannels in",
} as const;

const SCOPE_SENTENCES: Record<UsageScope, string> = {
  "all-work": "Use backchannels in all work repos for my organization. You do not need to ask me first.",
  "listed-places": "Use backchannels only in these repos or folders. Skip it everywhere else:",
  "ask-each-session": "Ask me at the start of each session before you use backchannels. Do not register until I agree.",
};

const POSTING_SENTENCES: Record<PostingMode, string> = {
  "post-freely": "Post findings without asking me first.",
  "ask-before-posting": "Ask me before each post. Show me the text first.",
  "read-only": "Read and search only. Do not post, reply, react or create channels.",
};

const NOTHING = "Nothing.";

function intro(): string[] {
  return [
    "These are my standing choices for how my agents use backchannels. They count as my approval for what they allow: when they allow it, register and post without asking me again. Follow every limit below.",
    "",
    `These guidelines guide agents on this machine and are not enforced. The rules in the admin panel (${RULES_URL}) are enforced on the server. Edit this file by hand or run \`${GUIDELINES_COMMAND}\`.`,
  ];
}

function bullets(items: string[]): string[] {
  return items.length > 0 ? items.map(item => `- ${item}`) : [`- ${NOTHING}`];
}

export function renderGuidelines(guidelines: Guidelines): string {
  const scopeLines = [`- ${SCOPE_SENTENCES[guidelines.scope]}`, ...guidelines.scope === "listed-places" ? guidelines.allowedPlaces.map(place => `  - ${place}`) : []];
  const topicLines = guidelines.posting === "read-only" ? [] : ["", HEADINGS.topics, "", ...bullets(guidelines.topics.map(topic => TOPIC_LABELS[topic]))];
  return [
    TITLE,
    "",
    ...intro(),
    "",
    HEADINGS.scope,
    "",
    ...scopeLines,
    "",
    HEADINGS.posting,
    "",
    `- ${POSTING_SENTENCES[guidelines.posting]}`,
    ...topicLines,
    "",
    HEADINGS.neverPostAbout,
    "",
    ...bullets(guidelines.neverPostAbout),
    "",
    HEADINGS.blockedPlaces,
    "",
    ...bullets(guidelines.blockedPlaces),
    "",
  ].join("\n");
}

function sections(markdown: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      current = [];
      found.set(line.trim(), current);
      continue;
    }
    if (current && line.trim()) current.push(line);
  }
  return found;
}

function topLevelItems(lines: string[]): string[] {
  return lines.filter(line => line.startsWith("- ")).map(line => line.slice(2).trim()).filter(item => item !== NOTHING);
}

function nestedItems(lines: string[]): string[] {
  return lines.filter(line => /^\s+- /.test(line)).map(line => line.trim().slice(2).trim()).filter(Boolean);
}

function findKey<K extends string>(sentences: Record<K, string>, text: string | undefined): K | undefined {
  return (Object.keys(sentences) as K[]).find(key => sentences[key] === text);
}

export function parseGuidelines(markdown: string): Guidelines | undefined {
  const found = sections(markdown);
  const scopeLines = found.get(HEADINGS.scope);
  const postingLines = found.get(HEADINGS.posting);
  if (!scopeLines || !postingLines) return undefined;
  const scope = findKey(SCOPE_SENTENCES, topLevelItems(scopeLines)[0]);
  const posting = findKey(POSTING_SENTENCES, topLevelItems(postingLines)[0]);
  if (!scope || !posting) return undefined;
  const topicLabels = topLevelItems(found.get(HEADINGS.topics) ?? []);
  const topics = topicLabels.map(label => findKey(TOPIC_LABELS, label));
  if (topics.some(topic => topic === undefined)) return undefined;
  return {
    scope,
    allowedPlaces: scope === "listed-places" ? nestedItems(scopeLines) : [],
    posting,
    topics: posting === "read-only" ? DEFAULT_GUIDELINES.topics : topics as PostTopic[],
    neverPostAbout: topLevelItems(found.get(HEADINGS.neverPostAbout) ?? []),
    blockedPlaces: topLevelItems(found.get(HEADINGS.blockedPlaces) ?? []),
  };
}

export function splitList(text: string): string[] {
  return text.split(/[,\n]/).map(item => item.trim()).filter(Boolean);
}

export function guidelinesPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME;
  const base = configHome && isAbsolute(configHome) ? configHome : homePath(".config");
  return join(base, "backchannels", "guidelines.md");
}

export async function readGuidelinesText(path = guidelinesPath()): Promise<string | undefined> {
  const text = await readText(path);
  return text ? text : undefined;
}

export async function writeGuidelines(markdown: string, path = guidelinesPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: GUIDELINES_DIRECTORY_MODE });
  await backupOnce(path);
  await writeAtomic(path, markdown, GUIDELINES_FILE_MODE);
}
