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

function isBackchannelsHandler(handler: unknown): boolean {
  return isJsonObject(handler) && typeof handler.command === "string" && handler.command.includes(`/${SKILL_DIRECTORY_NAME}/${SESSION_START_FILE}`);
}

function parseHookSettings(source: string): { settings: JsonObject; hooks: JsonObject; sessionStartGroups: unknown[] } {
  const settings: unknown = source.trim() ? JSON.parse(source) : {};
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

function withoutBackchannelsHandlers(group: unknown): unknown {
  const handlers = handlersOf(group);
  if (!handlers.some(isBackchannelsHandler)) return group;
  const remainingHandlers = handlers.filter(handler => !isBackchannelsHandler(handler));
  if (remainingHandlers.length === 0) return undefined;
  return { ...(group as JsonObject), hooks: remainingHandlers };
}

export function setSessionHook(source: string, command: string): string {
  if (hasSessionHook(source, command)) return source;
  const { settings, hooks, sessionStartGroups } = parseHookSettings(source);
  const foreignGroups = sessionStartGroups.map(withoutBackchannelsHandlers).filter(group => group !== undefined);
  const backchannelsGroup = { matcher: SESSION_EVENTS, hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS }] };
  hooks.SessionStart = [...foreignGroups, backchannelsGroup];
  settings.hooks = hooks;
  return `${JSON.stringify(settings, null, 2)}\n`;
}

export async function installSessionHookActions(agent: AgentName, placement: SkillPlacement): Promise<Action[]> {
  const settingsPath = hookSettingsPath(agent);
  if (!settingsPath || !placement.installPath) return [];
  const command = sessionHookCommand(sessionStartTextPath(placement.installPath));
  return fileUpdateAction(settingsPath, source => setSessionHook(source, command), "add the backchannels SessionStart hook");
}

export async function readSessionHookInstalled(agent: AgentName, placement: SkillPlacement): Promise<boolean | undefined> {
  const settingsPath = hookSettingsPath(agent);
  if (!settingsPath || !placement.installPath) return undefined;
  return hasSessionHook(await readText(settingsPath), sessionHookCommand(sessionStartTextPath(placement.installPath)));
}
