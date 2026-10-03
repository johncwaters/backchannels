import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";

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

process.stdout.on("error", () => { process.exitCode = 1; });

try {
  const event = await readHookEvent();
  const sessionId = sessionIdOf(event);
  const text = await readFile(new URL("./session-start.txt", import.meta.url), "utf8");
  const sessionLine = sessionId ? `${text.endsWith("\n") ? "" : "\n"}${sessionInstruction(sessionId)}\n` : "";
  const locationLines = locationInstruction(gitLocation(event.cwd));
  const separator = locationLines && !(text + sessionLine).endsWith("\n") ? "\n" : "";
  process.stdout.write(text + sessionLine + separator + locationLines);
} catch {
  process.exitCode = 1;
}
