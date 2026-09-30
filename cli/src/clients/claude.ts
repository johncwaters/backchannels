import { MCP_URL } from "../constants.js";
import { exists, hasCommand, homePath, isMissingServer, requireSuccess, run, supportsCommands } from "../machine.js";
import type { Action, ClientAdapter, ClientState, Detection, Machine, SignIn } from "../types.js";

const LOGIN_COMMAND = "claude mcp login backchannels";

export function parseClaudeRegistration(output: string): { url?: string } {
  const url = output.match(/^\s*URL:\s*(\S+)\s*$/m)?.[1];
  return url ? { url } : {};
}

export function parseClaudeSignIn(output: string): SignIn {
  const status = output.match(/^\s*Status:\s*(.+)$/m)?.[1];
  if (!status) return "unknown";
  return status.startsWith("✔") ? "signed-in" : "signed-out";
}

async function isPresent(_machine: Machine): Promise<boolean> {
  return await hasCommand("claude") || await exists(homePath(".claude"));
}

async function detect(machine: Machine): Promise<Detection> {
  const hasCli = await hasCommand("claude");
  return {
    present: await isPresent(machine),
    hasCli,
    supportsCommands: hasCli && await supportsCommands("claude", ["get", "remove", "add", "login"]),
  };
}

async function get(): Promise<string> {
  const output = await run(["claude", "mcp", "get", "backchannels"]);
  if (isMissingServer(output)) return "";
  requireSuccess(output, "Claude registration check");
  return output.stdout;
}

async function readRegistration(machine: Machine): Promise<{ url?: string }> {
  if (!(await detect(machine)).supportsCommands) return {};
  return parseClaudeRegistration(await get());
}

async function readSignIn(machine: Machine): Promise<SignIn> {
  if (!(await detect(machine)).supportsCommands) return "unknown";
  return parseClaudeSignIn(await get());
}

function needsSignIn(state: ClientState): boolean {
  return state.registration.url !== MCP_URL || state.signIn !== "signed-in";
}

async function installActions(machine: Machine, state: ClientState): Promise<Action[]> {
  if (!state.detection.supportsCommands) return [];
  const actions: Action[] = [];
  const hasCurrentEntry = state.registration.url === MCP_URL;
  if (state.registration.url !== undefined && !hasCurrentEntry) {
    actions.push({ kind: "command", argv: ["claude", "mcp", "remove", "backchannels", "--scope", "user"], interactive: false, isToleratedFailure: isMissingServer });
  }
  if (!hasCurrentEntry) {
    actions.push({ kind: "command", argv: ["claude", "mcp", "add", "--transport", "http", "--scope", "user", "backchannels", MCP_URL], interactive: false, failureMessage: "Claude Code has no backchannels entry; rerun the installer." });
  }
  if (machine.canOpenBrowser && machine.isInteractive && needsSignIn(state)) {
    actions.push({ kind: "command", argv: LOGIN_COMMAND.split(" "), interactive: true, signsIn: true, failureMessage: `Sign in from a terminal: ${LOGIN_COMMAND}` });
  }
  return actions;
}

function notices(machine: Machine, state: ClientState): string[] {
  if (!state.detection.supportsCommands) return [
    "Claude CLI commands are unavailable. Run:",
    `claude mcp add --transport http --scope user backchannels ${MCP_URL}`,
    LOGIN_COMMAND,
  ];
  if (!needsSignIn(state)) return [];
  if (!machine.canOpenBrowser) return [`Sign in where a browser is available: ${LOGIN_COMMAND}`];
  if (!machine.isInteractive) return [`Sign in from a terminal: ${LOGIN_COMMAND}`];
  return [];
}

export const claude: ClientAdapter = { name: "claude", isPresent, detect, readRegistration, readSignIn, installActions, verifyRegistration: readRegistration, notices };
