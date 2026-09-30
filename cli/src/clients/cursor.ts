import { MCP_URL } from "../constants.js";
import { fileUpdateAction, readJsonEntry, readText, setJsonEntry } from "../config-file.js";
import { exists, hasCommand, homePath, run, supportsCommands } from "../machine.js";
import type { Action, ClientAdapter, ClientState, Detection, Machine, SignIn } from "../types.js";

const LOGIN_COMMAND = "agent mcp login backchannels";

export function cursorPath(): string {
  return homePath(".cursor", "mcp.json");
}

async function hasCursorCli(): Promise<boolean> {
  if (!await hasCommand("agent")) return false;
  const output = await run(["agent", "--version"]);
  return output.code === 0 && /\bCursor\b/i.test(output.stdout + output.stderr);
}

async function isPresent(_machine: Machine): Promise<boolean> {
  return await exists(homePath(".cursor")) || await hasCursorCli();
}

async function detect(_machine: Machine): Promise<Detection> {
  const hasCli = await hasCursorCli();
  return { present: hasCli || await exists(homePath(".cursor")), hasCli, supportsCommands: hasCli && await supportsCommands("agent", ["login"]) };
}

async function readRegistration(_machine: Machine): Promise<{ url?: string }> {
  return readJsonEntry(await readText(cursorPath()));
}

async function readSignIn(_machine: Machine): Promise<SignIn> {
  return "unknown";
}

async function installActions(machine: Machine, state: ClientState): Promise<Action[]> {
  const actions = await fileUpdateAction(cursorPath(), source => setJsonEntry(source, MCP_URL), "set mcpServers.backchannels URL");
  if (machine.canOpenBrowser && machine.isInteractive && state.detection.supportsCommands) {
    actions.push({ kind: "command", argv: LOGIN_COMMAND.split(" "), interactive: true, signsIn: true, failureMessage: `Sign in later: ${LOGIN_COMMAND}` });
  }
  return actions;
}

function notices(machine: Machine, state: ClientState): string[] {
  if (!state.detection.supportsCommands) return ["Cursor asks to sign in on first use."];
  if (!machine.canOpenBrowser) return [`Sign in where a browser is available: ${LOGIN_COMMAND}`];
  if (!machine.isInteractive) return [`Sign in from a terminal: ${LOGIN_COMMAND}`];
  return [];
}

export const cursor: ClientAdapter = { name: "cursor", isPresent, detect, readRegistration, readSignIn, installActions, verifyRegistration: readRegistration, notices };
