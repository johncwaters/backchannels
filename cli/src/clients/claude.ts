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
  if (/^✔\s*Connected\s*$/.test(status)) return "signed-in";
  const statusText = status.replace(/^[^\p{L}]+/u, "");
  if (/^(?:needs authentication|disconnected|not connected|failed to connect|failed)\s*$/i.test(statusText)) return "signed-out";
  return "unknown";
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

async function get(): Promise<string | undefined> {
  const output = await run(["claude", "mcp", "get", "backchannels"]);
  if (isMissingServer(output)) return undefined;
  requireSuccess(output, "Claude registration check");
  return output.stdout;
}

async function readRegistration(machine: Machine, detection?: Detection, readOutput = get): Promise<{ url?: string }> {
  if (!(detection ?? await detect(machine)).supportsCommands) return {};
  const output = await readOutput();
  if (output === undefined) return {};
  const registration = parseClaudeRegistration(output);
  if (!registration.url) throw new Error("Cannot read the Claude server URL; refusing to change its registration. Check claude mcp get backchannels from a terminal.");
  return registration;
}

async function readSignIn(machine: Machine, detection?: Detection, readOutput = get): Promise<SignIn> {
  if (!(detection ?? await detect(machine)).supportsCommands) return "unknown";
  return parseClaudeSignIn(await readOutput() ?? "");
}

function needsSignIn(state: ClientState): boolean {
  return state.registration.url !== MCP_URL || state.signIn === "signed-out";
}

async function installActions(machine: Machine, state: ClientState): Promise<Action[]> {
  if (!state.detection.supportsCommands) return [];
  const actions: Action[] = [];
  const hasCurrentEntry = state.registration.url === MCP_URL;
  if (state.registration.url !== undefined && !hasCurrentEntry) {
    actions.push({ kind: "command", summary: "remove the outdated backchannels entry", argv: ["claude", "mcp", "remove", "backchannels", "--scope", "user"], interactive: false, isToleratedFailure: isMissingServer });
  }
  if (!hasCurrentEntry) {
    actions.push({ kind: "command", summary: "register the MCP server", argv: ["claude", "mcp", "add", "--transport", "http", "--scope", "user", "backchannels", MCP_URL], interactive: false, failureMessage: "Claude Code has no backchannels entry; rerun the installer." });
  }
  if (machine.canOpenBrowser && machine.isInteractive && needsSignIn(state)) {
    actions.push({ kind: "command", summary: "sign in with Google", argv: LOGIN_COMMAND.split(" "), interactive: true, signsIn: true, failureMessage: `Sign in from a terminal: ${LOGIN_COMMAND}` });
  }
  return actions;
}

function notices(machine: Machine, state: ClientState): string[] {
  if (!state.detection.supportsCommands) return [
    "Claude CLI commands are unavailable. Run:",
    `claude mcp add --transport http --scope user backchannels ${MCP_URL}`,
    LOGIN_COMMAND,
  ];
  if (state.registration.url === MCP_URL && state.signIn === "unknown") return [`Claude sign-in state is unknown; check it from a terminal: ${LOGIN_COMMAND}`];
  if (!needsSignIn(state)) return [];
  if (!machine.canOpenBrowser) return [`Sign in where a browser is available: ${LOGIN_COMMAND}`];
  if (!machine.isInteractive) return [`Sign in from a terminal: ${LOGIN_COMMAND}`];
  return [];
}

export function createClaudeAdapter(): ClientAdapter {
  let cachedDetection: Promise<Detection> | undefined;
  let cachedOutput: Promise<string | undefined> | undefined;
  const detectOnce = (machine: Machine) => cachedDetection ??= detect(machine);
  const readOutput = () => cachedOutput ??= get();
  const registration = async (machine: Machine, detection?: Detection) => readRegistration(machine, detection ?? await detectOnce(machine), readOutput);
  return {
    name: "claude", isPresent, installActions, notices,
    detect: detectOnce,
    readRegistration: registration,
    readSignIn: async (machine, detection) => readSignIn(machine, detection ?? await detectOnce(machine), readOutput),
    verifyRegistration: registration,
    clearReadCache: () => { cachedOutput = undefined; },
  };
}
