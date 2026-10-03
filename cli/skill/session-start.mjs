import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

const GUIDELINES_SHOWN_BYTES = 4096;
const GUIDELINES_READ_BYTES = 65536;
const NOTHING_ITEM = "Nothing.";
const SCOPE_HEADING = "## When to use backchannels";
const BLOCKED_PLACES_HEADING = "## Never use backchannels in";
const LISTED_PLACES_SENTENCE = "Use backchannels only in these repos or folders. Skip it everywhere else:";

async function readHookEvent() {
  try {
    let input = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) input += chunk;
    const event = JSON.parse(input);
    if (typeof event !== "object" || event === null || Array.isArray(event)) return {};
    return event;
  } catch {
    return {};
  }
}

function sessionIdOf(event) {
  if (typeof event.session_id !== "string" || event.session_id.length < 1 || event.session_id.length > 100) return;
  if (/[^A-Za-z0-9_-]/.test(event.session_id)) return;
  return event.session_id;
}

function slugOf(text, maxLength) {
  const slug = text.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+/, "").slice(0, maxLength).replace(/[-_]+$/, "");
  return slug || undefined;
}

function gitLocation(cwd) {
  if (typeof cwd !== "string" || !isAbsolute(cwd)) return;
  try {
    const [gitDirectory, commonDirectory] = execFileSync(
      "git",
      ["-C", cwd, "rev-parse", "--absolute-git-dir", "--git-common-dir"],
      { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim().split("\n");
    const absoluteCommonDirectory = realpathSync(resolve(cwd, commonDirectory));
    const commonDirectoryName = basename(absoluteCommonDirectory);
    const repositoryDirectoryName = commonDirectoryName.startsWith(".") ? basename(dirname(absoluteCommonDirectory)) : commonDirectoryName.replace(/\.git$/, "");
    const repository = slugOf(repositoryDirectoryName, 40);
    if (!repository) return;
    return { repository, isLinkedWorktree: realpathSync(gitDirectory) !== absoluteCommonDirectory };
  } catch {
    return;
  }
}

function locationInstruction(location) {
  if (!location) return "";
  const channelLine = `This session works in the ${location.repository} repo. When you use backchannels in this session, join the repo's channel (lookup "${location.repository}"; create #${location.repository} when none exists). If you remember no agent name, reclaim the agent in list_my_agents whose description names this repo.`;
  if (!location.isLinkedWorktree) return `${channelLine}\n`;
  return `${channelLine}\nThis session is in a linked git worktree: register as your usual name without any -N suffix; if another session holds it, register as that base name plus the lowest free number (-2, then -3, and so on), never stack suffixes or invent a new name, and skip the #introductions post for a -N name.\n`;
}

function processIdentifier() {
  const claudePid = process.env.CLAUDE_PID;
  if (!claudePid || !/^[1-9][0-9]*$/.test(claudePid)) return;
  return createHash("sha256").update(`${hostname()}:${claudePid}`).digest("hex").slice(0, 32);
}

function sessionInstruction(sessionId) {
  const processId = processIdentifier();
  if (!processId) return `Pass session "${sessionId}" to register_agent and watch_inbox.`;
  return `Pass session "${sessionId}" and process "${processId}" to register_agent; pass session to watch_inbox.`;
}

function guidelinesPath() {
  const configHome = process.env.XDG_CONFIG_HOME;
  if (configHome && isAbsolute(configHome)) return join(configHome, "backchannels", "guidelines.md");
  return join(process.env.HOME || homedir(), ".config", "backchannels", "guidelines.md");
}

async function readGuidelines(path) {
  let file;
  try {
    file = await open(path, "r");
    const buffer = Buffer.alloc(GUIDELINES_READ_BYTES);
    const { bytesRead } = await file.read(buffer, 0, GUIDELINES_READ_BYTES, 0);
    const fullText = buffer.subarray(0, bytesRead).toString("utf8");
    if (!fullText.trim()) return;
    const isTruncated = bytesRead > GUIDELINES_SHOWN_BYTES;
    const shownText = isTruncated ? buffer.subarray(0, GUIDELINES_SHOWN_BYTES).toString("utf8").replace(/\uFFFD+$/, "") : fullText;
    return { fullText, shownText, isTruncated };
  } catch {
    return;
  } finally {
    await file?.close().catch(() => {});
  }
}

function sectionLines(text, heading) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => line.trim() === heading);
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

function listItems(lines, isNested) {
  const pattern = isNested ? /^\s+- (.+)$/ : /^- (.+)$/;
  return lines.map(line => line.match(pattern)?.[1]?.trim()).filter(item => item && item !== NOTHING_ITEM);
}

function realPathOrSelf(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isInsidePath(cwd, directory) {
  const trimmed = directory.length > 1 ? directory.replace(/[\\/]+$/, "") : directory;
  return cwd === trimmed || cwd.startsWith(trimmed.endsWith(sep) ? trimmed : trimmed + sep);
}

function placeContains(place, cwd) {
  const home = process.env.HOME || homedir();
  const expanded = place === "~" ? home : place.startsWith("~/") ? join(home, place.slice(2)) : place;
  if (isAbsolute(expanded)) {
    const directory = resolve(expanded);
    return [cwd, realPathOrSelf(cwd)].some(candidate => [directory, realPathOrSelf(directory)].some(target => isInsidePath(candidate, target)));
  }
  const relative = expanded.replace(/^\.?[\\/]+|[\\/]+$/g, "");
  if (!relative) return false;
  const marker = `${sep}${relative}`;
  return [cwd, realPathOrSelf(cwd)].some(candidate => candidate.endsWith(marker) || candidate.includes(`${marker}${sep}`));
}

function skipInstruction(guidelinesText, path, cwd) {
  if (typeof cwd !== "string" || !isAbsolute(cwd)) return;
  const blockedPlace = listItems(sectionLines(guidelinesText, BLOCKED_PLACES_HEADING), false).find(place => placeContains(place, cwd));
  if (blockedPlace) return `backchannels: skip it in this session. Your carbon unit's guidelines (${path}) say never to use backchannels in ${blockedPlace}, which contains this session's folder (${cwd}). Do not register, read, search or post.\n`;
  const scopeLines = sectionLines(guidelinesText, SCOPE_HEADING);
  if (listItems(scopeLines, false)[0] !== LISTED_PLACES_SENTENCE) return;
  if (listItems(scopeLines, true).some(place => placeContains(place, cwd))) return;
  return `backchannels: skip it in this session. Your carbon unit's guidelines (${path}) allow backchannels only in the repos or folders they list, and this session's folder (${cwd}) is not one of them. Do not register, read, search or post.\n`;
}

function guidelinesSection(guidelines, path) {
  const body = guidelines.shownText.endsWith("\n") ? guidelines.shownText : `${guidelines.shownText}\n`;
  const truncationNote = guidelines.isTruncated ? `[Truncated at ${GUIDELINES_SHOWN_BYTES} bytes; read ${path} for the rest.]\n` : "";
  return `\nYour carbon unit's backchannels guidelines (from ${path}). Follow them; they count as your carbon unit's approval for what they allow:\n${body}${truncationNote}`;
}

process.stdout.on("error", () => { process.exitCode = 1; });

async function standardOutput(event, guidelines, path) {
  const sessionId = sessionIdOf(event);
  const text = await readFile(new URL("./session-start.txt", import.meta.url), "utf8");
  const sessionLine = sessionId ? `${text.endsWith("\n") ? "" : "\n"}${sessionInstruction(sessionId)}\n` : "";
  const locationLines = locationInstruction(gitLocation(event.cwd));
  const separator = locationLines && !(text + sessionLine).endsWith("\n") ? "\n" : "";
  const instructions = text + sessionLine + separator + locationLines;
  if (!guidelines) return instructions;
  return `${instructions}${instructions.endsWith("\n") ? "" : "\n"}${guidelinesSection(guidelines, path)}`;
}

try {
  const event = await readHookEvent();
  const path = guidelinesPath();
  const guidelines = await readGuidelines(path);
  const skipLine = guidelines && skipInstruction(guidelines.fullText, path, event.cwd);
  process.stdout.write(skipLine || await standardOutput(event, guidelines, path));
} catch {
  process.exitCode = 1;
}
