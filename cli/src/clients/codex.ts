import { dirname, join } from "node:path";
import { MCP_URL } from "../constants.js";
import { backupOnce, fileUpdateAction, readText, readTomlTableUrl, resolveFile, setTomlTable } from "../config-file.js";
import { exists, hasCommand, homePath, isMissingServer, requireSuccess, run, supportsCommands } from "../machine.js";
import type { Action, ClientAdapter, ClientState, Detection, Machine, SignIn } from "../types.js";

export function codexPath(): string {
  return join(process.env.CODEX_HOME || homePath(".codex"), "config.toml");
}

export function parseCodexRegistration(output: string): { url?: string } {
  const configuration = JSON.parse(output);
  const url = configuration?.transport?.url;
  if (typeof url !== "string") return {};
  return { url };
}

export function parseCodexSignIn(output: string): SignIn {
  const servers: unknown = JSON.parse(output);
  if (!Array.isArray(servers)) throw new Error("Codex server list must be an array.");
  const server = servers.find(server => server?.name === "backchannels");
  if (!server) return "signed-out";
  if (typeof server.auth_status !== "string") return "unknown";
  return server.auth_status === "o_auth" ? "signed-in" : "signed-out";
}

async function isPresent(_machine: Machine): Promise<boolean> {
  return await hasCommand("codex") || await exists(dirname(codexPath()));
}

async function detect(machine: Machine): Promise<Detection> {
  const hasCli = await hasCommand("codex");
  return {
    present: await isPresent(machine),
    hasCli,
    supportsCommands: hasCli && await supportsCommands("codex", ["get", "list", "add", "login"]),
  };
}

async function verifyRegistration(_machine: Machine): Promise<{ url?: string }> {
  const url = readTomlTableUrl(await readText(codexPath()));
  return url ? { url } : {};
}

async function readRegistration(machine: Machine): Promise<{ url?: string }> {
  if (!(await detect(machine)).supportsCommands) return verifyRegistration(machine);
  const output = await run(["codex", "mcp", "get", "backchannels", "--json"]);
  if (isMissingServer(output)) return {};
  requireSuccess(output, "Codex registration check");
  return parseCodexRegistration(output.stdout);
}

async function readSignIn(machine: Machine): Promise<SignIn> {
  if (!(await detect(machine)).supportsCommands) return "unknown";
  const output = await run(["codex", "mcp", "list", "--json"]);
  requireSuccess(output, "Codex sign-in check");
  return parseCodexSignIn(output.stdout);
}

async function backupAction(): Promise<Action> {
  const resolvedPath = await resolveFile(codexPath());
  return { kind: "file", path: resolvedPath, describe: `backup ${resolvedPath}.backchannels.bak if the file exists`, apply: () => backupOnce(resolvedPath) };
}

async function installActions(machine: Machine, state: ClientState): Promise<Action[]> {
  const needsRegistration = state.registration.url !== MCP_URL;
  const canUseCommands = state.detection.supportsCommands;
  if (needsRegistration && canUseCommands && machine.canOpenBrowser) {
    return [await backupAction(), { kind: "command", argv: ["codex", "mcp", "add", "backchannels", "--url", MCP_URL], interactive: true, signsIn: true }];
  }
  const actions: Action[] = [];
  if (needsRegistration) actions.push(...await fileUpdateAction(codexPath(), source => setTomlTable(source, MCP_URL), "set [mcp_servers.backchannels] URL"));
  if (canUseCommands && machine.canOpenBrowser && state.signIn !== "signed-in") {
    actions.push({ kind: "command", argv: ["codex", "mcp", "login", "backchannels"], interactive: true, signsIn: true, failureMessage: "Sign in from a terminal: codex mcp login backchannels" });
  }
  return actions;
}

function notices(machine: Machine, state: ClientState): string[] {
  if (!state.detection.supportsCommands) return ["Codex CLI commands are unavailable; Codex signs in on first use."];
  if (!machine.canOpenBrowser && (state.registration.url !== MCP_URL || state.signIn !== "signed-in")) return ["Sign in without a browser: codex mcp login backchannels --no-browser"];
  return [];
}

export const codex: ClientAdapter = { name: "codex", isPresent, detect, readRegistration, readSignIn, installActions, verifyRegistration, notices };
