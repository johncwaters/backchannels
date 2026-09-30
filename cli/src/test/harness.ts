import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../machine.js";
import type { Machine } from "../types.js";

export interface FakeState {
  claude: { url?: string; signedIn?: boolean };
  codex: { url?: string; signedIn?: boolean };
  cursor: { signedIn?: boolean };
  unsupported?: string[];
  failing?: string[];
  agentVersion?: string;
}

const fakeSource = String.raw`#!/usr/bin/env node
const { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } = require("node:fs");
const { basename, join, dirname } = require("node:path");
const client = basename(process.argv[1]);
const arguments_ = process.argv.slice(2);
const statePath = process.env.FAKE_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const name = client === "agent" ? "cursor" : client;
appendFileSync(process.env.FAKE_CALLS, JSON.stringify([client, ...arguments_]) + "\n");
const operation = arguments_[1];
const commandName = client + ":" + operation;
if (arguments_.includes("--help")) process.exit((state.unsupported || []).includes(commandName) ? 1 : 0);
if (arguments_[0] === "--version") {
  console.log(client === "agent" ? (state.agentVersion || "Cursor Agent 2026.09") : client + " 1.0");
  process.exit(0);
}
if ((state.failing || []).includes(commandName)) process.exit(3);
const configPath = join(process.env.CODEX_HOME, "config.toml");
if (name === "codex") {
  state.codex.url = undefined;
  if (existsSync(configPath)) {
    const config = readFileSync(configPath, "utf8");
    const table = config.match(/^\[mcp_servers\.backchannels\][^\n]*\n([\s\S]*?)(?=^\[|(?![\s\S]))/m);
    const url = table && table[1].match(/^url\s*=\s*"([^"]+)"/m);
    if (url) state.codex.url = url[1];
  }
}
function save() { writeFileSync(statePath, JSON.stringify(state)); }
function codexConfig(url) {
  mkdirSync(dirname(configPath), { recursive: true });
  const previous = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const cleared = previous.replace(/^\[mcp_servers\.backchannels\][^\n]*\n[\s\S]*?(?=^\[|(?![\s\S]))/m, "");
  writeFileSync(configPath, cleared + (url ? "\n[mcp_servers.backchannels]\nurl = " + JSON.stringify(url) + "\n" : ""));
}
if (operation === "get") {
  if (!state[name].url) {
    console.error(client === "claude" ? 'No MCP server named "backchannels". Configured servers: foreign' : "Error: No MCP server named 'backchannels' found.");
    process.exit(1);
  }
  if (name === "claude") {
    console.log("backchannels:\n  Scope: User config (available in all your projects)\n  Status: " + (state.claude.signedIn ? "✔ Connected" : "✘ Not connected") + "\n  Type: http\n  URL: " + state.claude.url);
    process.exit(0);
  }
  console.log(JSON.stringify({ name: "backchannels", enabled: true, disabled_reason: null, transport: { type: "streamable_http", url: state.codex.url, bearer_token_env_var: null, http_headers: null, env_http_headers: null, http_headers_helper: null }, enabled_tools: null, disabled_tools: null, startup_timeout_sec: null, tool_timeout_sec: null }));
  process.exit(0);
}
if (operation === "list") {
  console.log(JSON.stringify(state.codex.url ? [{ name: "backchannels", transport: { type: "streamable_http", url: state.codex.url }, auth_status: state.codex.signedIn ? "o_auth" : "not_logged_in" }] : []));
  process.exit(0);
}
if (operation === "add") {
  state[name].url = arguments_[arguments_.length - 1];
  if (name === "codex") {
    state.codex.signedIn = true;
    codexConfig(state.codex.url);
  }
  save();
  process.exit(0);
}
if (operation === "remove") {
  if (!state[name].url) {
    console.error('No MCP server named "backchannels".');
    process.exit(1);
  }
  delete state[name].url;
  if (name === "codex") codexConfig();
  save();
  process.exit(0);
}
if (operation === "login" || operation === "logout") {
  state[name].signedIn = operation === "login";
  save();
  process.exit(0);
}
process.exit(2);
`;

export async function createHarness(clients = ["claude", "codex", "agent"]) {
  const directory = await mkdtemp(join(tmpdir(), "backchannels-test-"));
  const binaryDirectory = join(directory, "bin");
  const home = join(directory, "home");
  await mkdir(binaryDirectory);
  await mkdir(home);
  const statePath = join(directory, "state.json");
  const callsPath = join(directory, "calls.log");
  await writeFile(statePath, JSON.stringify({ claude: {}, codex: {}, cursor: {} }));
  await writeFile(callsPath, "");
  for (const client of clients) await writeFile(join(binaryDirectory, client), fakeSource, { mode: 0o755 });
  const previousEnvironment = { ...process.env };
  process.env.HOME = home;
  process.env.CODEX_HOME = join(home, "custom-codex");
  process.env.PATH = binaryDirectory;
  process.env.FAKE_STATE = statePath;
  process.env.FAKE_CALLS = callsPath;
  for (const client of clients) {
    const source = fakeSource.replace("#!/usr/bin/env node", `#!${process.execPath}`);
    await writeFile(join(binaryDirectory, client), source, { mode: 0o755 });
  }
  return {
    home,
    directory,
    statePath,
    callsPath,
    codexConfig: join(process.env.CODEX_HOME, "config.toml"),
    cursorConfig: join(home, ".cursor", "mcp.json"),
    async state(): Promise<FakeState> { return JSON.parse(await readFile(statePath, "utf8")); },
    async setState(state: FakeState) { await writeFile(statePath, JSON.stringify(state)); },
    async calls(): Promise<string[][]> { return (await readFile(callsPath, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line)); },
    async invoke(arguments_: string[] = [], machine: Machine = { isInteractive: false, canOpenBrowser: true }) {
      const runner = fileURLToPath(new URL("./runner.js", import.meta.url));
      return run([process.execPath, runner, JSON.stringify(machine), ...arguments_]);
    },
    async close() {
      process.env = previousEnvironment;
      await rm(directory, { recursive: true, force: true });
    },
  };
}
