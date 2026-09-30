import { lstat, mkdir, open, readFile, readlink, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { hasErrorCode } from "./machine.js";
import type { Action } from "./types.js";

export async function resolveFile(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
  try {
    if ((await lstat(path)).isSymbolicLink()) return resolveFile(resolve(dirname(path), await readlink(path)));
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
  const parent = dirname(path);
  if (parent === path) return path;
  return resolve(await resolveFile(parent), path.slice(parent.length + 1));
}

export async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return "";
    throw error;
  }
}

export async function backupOnce(path: string): Promise<void> {
  const resolvedPath = await resolveFile(path);
  let original: Buffer;
  try {
    original = await readFile(resolvedPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw error;
  }
  let backup;
  try {
    backup = await open(`${resolvedPath}.backchannels.bak`, "wx", 0o600);
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) return;
    throw error;
  }
  try {
    await backup.chmod(0o600);
    await backup.writeFile(original);
  } finally {
    await backup.close();
  }
}

export async function writeAtomic(path: string, text: string, newFileMode = 0o600): Promise<void> {
  const resolvedPath = await resolveFile(path);
  let originalMode = newFileMode;
  try {
    originalMode = (await stat(resolvedPath)).mode & 0o777;
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
  await mkdir(dirname(resolvedPath), { recursive: true });
  const temporaryPath = `${resolvedPath}.${randomUUID()}.tmp`;
  try {
    const temporaryFile = await open(temporaryPath, "wx", 0o600);
    try {
      await temporaryFile.writeFile(text);
      await temporaryFile.chmod(originalMode);
    } finally {
      await temporaryFile.close();
    }
    await rename(temporaryPath, resolvedPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function parseJson(source: string): Record<string, unknown> {
  const configuration: unknown = source.trim() ? JSON.parse(source) : {};
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) throw new Error("Config must be a JSON object.");
  const object = configuration as Record<string, unknown>;
  const servers = object.mcpServers;
  if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers))) throw new Error("mcpServers must be a JSON object.");
  return object;
}

export function readJsonEntry(source: string): { url?: string } {
  const configuration = parseJson(source);
  const servers = configuration.mcpServers as Record<string, unknown> | undefined;
  const entry = servers?.backchannels;
  if (!entry || typeof entry !== "object" || !("url" in entry) || typeof entry.url !== "string") return {};
  return { url: entry.url };
}

export function setJsonEntry(source: string, url: string): string {
  if (readJsonEntry(source).url === url) return source;
  const configuration = parseJson(source);
  const servers = (configuration.mcpServers ?? {}) as Record<string, unknown>;
  const entry = servers.backchannels;
  const isEntryObject = entry !== null && typeof entry === "object" && !Array.isArray(entry);
  servers.backchannels = isEntryObject ? { ...entry, url } : { url };
  configuration.mcpServers = servers;
  return `${JSON.stringify(configuration, null, 2)}\n`;
}

function scanTomlLines(source: string): { text: string; index: number; isSyntax: boolean }[] {
  const lines: { text: string; index: number; isSyntax: boolean }[] = [];
  let stringDelimiter = "";
  for (const line of source.matchAll(/[^\n]*(?:\n|$)/g)) {
    const text = line[0];
    lines.push({ text, index: line.index, isSyntax: !stringDelimiter });
    for (let position = 0; position < text.length; position++) {
      const character = text[position];
      if (stringDelimiter) {
        if (stringDelimiter.startsWith('"') && character === "\\") {
          position++;
          continue;
        }
        if (!text.startsWith(stringDelimiter, position)) continue;
        position += stringDelimiter.length - 1;
        if (stringDelimiter.length === 3) {
          while (text[position + 1] === character) position++;
        }
        stringDelimiter = "";
        continue;
      }
      if (character === "#") break;
      if (character !== '"' && character !== "'") continue;
      stringDelimiter = text.startsWith(character.repeat(3), position) ? character.repeat(3) : character;
      position += stringDelimiter.length - 1;
    }
    if (stringDelimiter.length === 1) throw new Error("Unterminated TOML string.");
  }
  if (stringDelimiter) throw new Error("Unterminated TOML multiline string.");
  return lines;
}

const MCP_SERVERS_KEY = String.raw`(?:mcp_servers|"mcp_servers"|'mcp_servers')`;
const BACKCHANNELS_KEY = String.raw`(?:backchannels|"backchannels"|'backchannels')`;
const TABLE_HEADER = /^[\t ]*\[[^\r\n]+\][\t ]*(?:#[^\r\n]*)?\r?(?:\n|$)$/;
const BACKCHANNELS_HEADER = new RegExp(String.raw`^[\t ]*\[\s*${MCP_SERVERS_KEY}\s*\.\s*${BACKCHANNELS_KEY}\s*\]`);
const MCP_SERVERS_HEADER = new RegExp(String.raw`^[\t ]*\[\s*${MCP_SERVERS_KEY}\s*\]`);
const ROOT_DOTTED_ENTRY = new RegExp(String.raw`^[\t ]*${MCP_SERVERS_KEY}\s*\.\s*${BACKCHANNELS_KEY}\s*[.=]`);
const ROOT_INLINE_SERVERS = new RegExp(String.raw`^[\t ]*${MCP_SERVERS_KEY}\s*=`);
const SERVERS_TABLE_ENTRY = new RegExp(String.raw`^[\t ]*${BACKCHANNELS_KEY}\s*[.=]`);
const URL_KEY = /^[\t ]*(?:url|"url"|'url')\s*=/;
const MULTILINE_URL = /^[\t ]*(?:url|"url"|'url')\s*=\s*(?:"""|''')/;

function lineEnding(source: string): string {
  return source.includes("\r\n") ? "\r\n" : "\n";
}

function hasInlineOrDottedEntry(source: string): boolean {
  let isInRoot = true;
  let isInServersTable = false;
  for (const line of scanTomlLines(source)) {
    if (!line.isSyntax) continue;
    if (TABLE_HEADER.test(line.text)) {
      isInRoot = false;
      isInServersTable = MCP_SERVERS_HEADER.test(line.text);
      continue;
    }
    if (isInRoot && (ROOT_DOTTED_ENTRY.test(line.text) || ROOT_INLINE_SERVERS.test(line.text))) return true;
    if (isInServersTable && SERVERS_TABLE_ENTRY.test(line.text)) return true;
  }
  return false;
}

function findTomlTable(source: string): { start: number; end: number; body: string } | undefined {
  const headers = scanTomlLines(source).filter(line => line.isSyntax && TABLE_HEADER.test(line.text));
  const matchingHeaders = headers.filter(header => BACKCHANNELS_HEADER.test(header.text));
  if (matchingHeaders.length > 1) throw new Error("Duplicate backchannels TOML tables.");
  const header = matchingHeaders[0];
  if (!header) return;
  const nextHeader = headers.find(candidate => candidate.index > header.index);
  const start = header.index;
  const boundary = nextHeader?.index ?? source.length;
  const body = source.slice(start, boundary);
  const trailing = body.match(/(?:(?<!\r)^[\t ]*(?:#[^\r\n]*)?\r?(?:\n|$))+(?![\s\S])/m);
  const end = trailing ? start + trailing.index! : boundary;
  return { start, end, body: source.slice(start, end) };
}

export function readTomlTableUrl(source: string): string | undefined {
  const table = findTomlTable(source);
  if (!table) return;
  for (const line of scanTomlLines(table.body)) {
    if (!line.isSyntax) continue;
    const assignment = line.text.match(/^[\t ]*(?:url|"url"|'url')\s*=\s*("(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*')[\t ]*(?:#[^\r\n]*)?\r?(?:\n|$)$/);
    if (!assignment) continue;
    if (assignment[1].startsWith("'")) return assignment[1].slice(1, -1);
    return JSON.parse(assignment[1]) as string;
  }
}

export function setTomlTable(source: string, url: string): string {
  const urlAssignment = `url = ${JSON.stringify(url)}`;
  if (hasInlineOrDottedEntry(source)) throw new Error(`mcp_servers or mcp_servers.backchannels is defined inline or with dotted keys; edit that entry by hand to set ${urlAssignment}.`);
  if (readTomlTableUrl(source) === url) return source;
  const newline = lineEnding(source);
  const table = findTomlTable(source);
  if (!table) return source + (source && !source.endsWith("\n") ? newline : "") + `[mcp_servers.backchannels]${newline}${urlAssignment}${newline}`;
  const urlLine = scanTomlLines(table.body).find(line => line.isSyntax && URL_KEY.test(line.text));
  if (urlLine && MULTILINE_URL.test(urlLine.text)) throw new Error(`mcp_servers.backchannels url is a multiline string; edit that entry by hand to set ${urlAssignment}.`);
  if (urlLine) {
    const indentation = urlLine.text.match(/^[\t ]*/)![0];
    const ending = urlLine.text.match(/\r?\n$/)?.[0] ?? "";
    const urlLineStart = table.start + urlLine.index;
    return source.slice(0, urlLineStart) + indentation + urlAssignment + ending + source.slice(urlLineStart + urlLine.text.length);
  }
  const headerLine = table.body.match(/^[^\n]*(?:\n|$)/)![0];
  const insertAt = table.start + headerLine.length;
  const headerEnding = headerLine.endsWith("\n") ? "" : newline;
  return source.slice(0, insertAt) + headerEnding + urlAssignment + newline + source.slice(insertAt);
}

export async function fileUpdateAction(path: string, computeUpdated: (current: string) => string, describe: string, newFileMode = 0o600): Promise<Action[]> {
  const current = await readText(path);
  if (computeUpdated(current) === current) return [];
  const resolvedPath = await resolveFile(path);
  return [{ kind: "file", path: resolvedPath, describe: `${describe}; preserve mode; backup ${resolvedPath}.backchannels.bak if the file exists`, apply: async () => {
    const fresh = await readText(resolvedPath);
    const updated = computeUpdated(fresh);
    if (updated === fresh) return;
    await backupOnce(resolvedPath);
    await writeAtomic(resolvedPath, updated, newFileMode);
  } }];
}
