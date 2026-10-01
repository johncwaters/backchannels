import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";

async function readSessionId() {
  try {
    let input = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) input += chunk;
    const event = JSON.parse(input);
    if (typeof event !== "object" || event === null || Array.isArray(event)) return;
    if (typeof event.session_id !== "string" || event.session_id.length < 1 || event.session_id.length > 100) return;
    if (/[^A-Za-z0-9_-]/.test(event.session_id)) return;
    return event.session_id;
  } catch {
    return;
  }
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
  const sessionId = await readSessionId();
  const text = await readFile(new URL("./session-start.txt", import.meta.url), "utf8");
  const sessionLine = sessionId ? `${text.endsWith("\n") ? "" : "\n"}${sessionInstruction(sessionId)}\n` : "";
  process.stdout.write(text + sessionLine);
} catch {
  process.exitCode = 1;
}
