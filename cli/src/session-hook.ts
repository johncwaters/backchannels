import { dirname, join } from "node:path";
import { codexPath } from "./clients/codex.js";
import { fileUpdateAction, readText } from "./config-file.js";
import { homePath } from "./machine.js";
import { SESSION_START_FILE, SKILL_DIRECTORY_NAME, sessionStartTextPath, type SkillPlacement } from "./skill.js";
import type { Action, AgentName } from "./types.js";

const SESSION_EVENTS = "startup|resume|clear";
const HOOK_TIMEOUT_SECONDS = 5;

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hookSettingsPath(agent: AgentName): string | undefined {
  if (agent === "claude") return homePath(".claude", "settings.json");
  if (agent === "codex") return join(dirname(codexPath()), "hooks.json");
  return undefined;
}

export function sessionHookCommand(textPath: string): string {
  return `cat '${textPath.replaceAll("'", `'\\''`)}' 2>/dev/null || true`;
}

function isBackchannelsHandler(handler: unknown): handler is JsonObject {
  return isJsonObject(handler) && typeof handler.command === "string" && handler.command.includes(`/${SKILL_DIRECTORY_NAME}/${SESSION_START_FILE}`);
}

function parseHookSettings(source: string): { settings: JsonObject; hooks: JsonObject; sessionStartGroups: unknown[] } {
  let settings: unknown = {};
  try {
    if (source.trim()) settings = JSON.parse(source);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error("Refusing to change hook settings: invalid JSON. Repair the settings file and rerun the installer.");
  }
  if (!isJsonObject(settings)) throw new Error("Hook settings must be a JSON object.");
  const hooks = settings.hooks ?? {};
  if (!isJsonObject(hooks)) throw new Error("hooks must be a JSON object.");
  const sessionStartGroups = hooks.SessionStart ?? [];
  if (!Array.isArray(sessionStartGroups)) throw new Error("hooks.SessionStart must be a JSON array.");
  return { settings, hooks, sessionStartGroups };
}

function handlersOf(group: unknown): unknown[] {
  if (!isJsonObject(group) || !Array.isArray(group.hooks)) return [];
  return group.hooks;
}

export function hasSessionHook(source: string, command: string): boolean {
  const { sessionStartGroups } = parseHookSettings(source);
  return sessionStartGroups.some(group => handlersOf(group).some(handler => isJsonObject(handler) && handler.command === command));
}

const PLAIN_EVENT_LIST = /^[A-Za-z0-9_|]+$/;

type MatcherShape = { kind: "all"; isStar: boolean } | { kind: "list"; events: string[] } | { kind: "pattern" };

function matcherShapeOf(group: JsonObject): MatcherShape {
  const matcher = group.matcher;
  if (matcher === undefined || matcher === "" || matcher === "*") return { kind: "all", isStar: matcher === "*" };
  if (typeof matcher !== "string" || !PLAIN_EVENT_LIST.test(matcher)) return { kind: "pattern" };
  const events = matcher.split("|").filter(event => event !== "");
  return events.length > 0 ? { kind: "list", events } : { kind: "pattern" };
}

/** null: groups cannot be merged; undefined: kept matcher already covers the later group. */
function widenedMatcher(keptGroup: JsonObject, laterGroup: JsonObject): string | null | undefined {
  const kept = matcherShapeOf(keptGroup);
  const later = matcherShapeOf(laterGroup);
  if (kept.kind === "pattern" || later.kind === "pattern") return null;
  if (kept.kind === "all") return undefined;
  if (later.kind === "all") return later.isStar ? "*" : "";
  const unionEvents = [...new Set([...kept.events, ...later.events])];
  if (unionEvents.every(event => kept.events.includes(event))) return undefined;
  return unionEvents.join("|");
}

export function setSessionHook(source: string, command: string): string {
  const { settings, hooks, sessionStartGroups } = parseHookSettings(source);
  let keptHandler: JsonObject | undefined;
  let keptGroup: JsonObject | undefined;
  let isChanged = false;
  const retainedHandlers: JsonObject[] = [];
  const keptGroups: unknown[] = [];
  for (const group of sessionStartGroups) {
    const handlers = handlersOf(group);
    const keptHandlers: unknown[] = [];
    for (const handler of handlers) {
      if (!isBackchannelsHandler(handler)) {
        keptHandlers.push(handler);
        continue;
      }
      if (!keptHandler || !keptGroup) {
        keptHandler = handler;
        keptGroup = group as JsonObject;
        retainedHandlers.push(handler);
        keptHandlers.push(handler);
        continue;
      }
      const matcherAfterMerge = group === keptGroup ? undefined : widenedMatcher(keptGroup, group as JsonObject);
      const keptGroupHasOtherHandlers = handlersOf(keptGroup).some(other => !isBackchannelsHandler(other));
      if (matcherAfterMerge === null || (matcherAfterMerge !== undefined && keptGroupHasOtherHandlers)) {
        retainedHandlers.push(handler);
        keptHandlers.push(handler);
        continue;
      }
      if (matcherAfterMerge !== undefined) keptGroup.matcher = matcherAfterMerge;
      isChanged = true;
    }
    if (keptHandlers.length === handlers.length) {
      keptGroups.push(group);
      continue;
    }
    if (keptHandlers.length === 0 || !isJsonObject(group)) continue;
    group.hooks = keptHandlers;
    keptGroups.push(group);
  }
  if (retainedHandlers.some(handler => handler.command !== command)) isChanged = true;
  if (keptHandler && !isChanged) return source;
  for (const handler of retainedHandlers) handler.command = command;
  if (!keptHandler) keptGroups.push({ matcher: SESSION_EVENTS, hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS }] });
  hooks.SessionStart = keptGroups;
  settings.hooks = hooks;
  return `${JSON.stringify(settings, null, 2)}\n`;
}

export async function installSessionHookActions(agent: AgentName, placement: SkillPlacement): Promise<Action[]> {
  const settingsPath = hookSettingsPath(agent);
  if (!settingsPath || !placement.installPath) return [];
  const command = sessionHookCommand(sessionStartTextPath(placement.installPath));
  return fileUpdateAction(settingsPath, source => {
    try {
      return setSessionHook(source, command);
    } catch (error) {
      throw new Error(`${settingsPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, "add the backchannels SessionStart hook");
}

export async function readSessionHookInstalled(agent: AgentName, placement: SkillPlacement): Promise<boolean | undefined> {
  const settingsPath = hookSettingsPath(agent);
  if (!settingsPath || !placement.installPath) return undefined;
  return hasSessionHook(await readText(settingsPath), sessionHookCommand(sessionStartTextPath(placement.installPath)));
}
