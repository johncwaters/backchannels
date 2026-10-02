import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "../machine.js";
import { createHarness } from "./harness.js";
import { exists } from "../machine.js";
import { readSessionHookInstalled, sessionHookCommand } from "../session-hook.js";
import { sessionStartScriptPath, sessionStartTextPath } from "../skill.js";

const packageVersion: string = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")).version;

const url = "https://api.backchannels.dev/mcp";
const terminalWithBrowser = { isInteractive: true, canOpenBrowser: true };
const claudeSkill = ".claude/skills/backchannels/SKILL.md";
const sharedSkill = ".agents/skills/backchannels/SKILL.md";
const claudeHookSettings = ".claude/settings.json";

async function sessionStartCommands(settingsPath: string): Promise<string[]> {
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  return settings.hooks.SessionStart.flatMap((group: { hooks: { command: string }[] }) => group.hooks.map(handler => handler.command));
}

async function snapshotFiles(directory: string): Promise<Record<string, { modified: number; hash: string }>> {
  const files: Record<string, { modified: number; hash: string }> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      Object.assign(files, await snapshotFiles(path));
      continue;
    }
    files[path] = { modified: (await stat(path)).mtimeMs, hash: createHash("sha256").update(await readFile(path)).digest("hex") };
  }
  return files;
}

async function seedFile(path: string, content: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

test("fresh machine installs all three clients and the exact planned commands", async () => {
  const harness = await createHarness();
  try {
    const output = await harness.invoke(["--yes"], terminalWithBrowser);
    assert.equal(output.code, 0, output.stdout + output.stderr);
    assert.match(output.stdout, /claude: registered/);
    assert.match(output.stdout, /codex: registered/);
    assert.match(output.stdout, /cursor: registered/);
    assert.match(output.stdout, /only posthog\.com Google accounts can sign in/);
    assert.equal((await harness.state()).claude.url, url);
    assert.equal((await harness.state()).codex.signedIn, true);
    assert.equal(JSON.parse(await readFile(harness.cursorConfig, "utf8")).mcpServers.backchannels.url, url);
    assert.equal(await exists(join(harness.home, ".claude/skills/backchannels/SKILL.md")), true);
    assert.equal(await exists(join(harness.home, ".agents/skills/backchannels/SKILL.md")), true);
    for (const skillPath of [claudeSkill, sharedSkill]) {
      const installedSkill = await readFile(join(harness.home, skillPath), "utf8");
      assert.ok(installedSkill.startsWith(`---\nmetadata:\n  version: "${packageVersion}"\n`));
      assert.ok(installedSkill.includes(`skill_version: "${packageVersion}"`));
      assert.ok(!installedSkill.includes("{{SKILL_VERSION}}"));
      const scriptTemplate = await readFile(new URL("../../skill/session-start.mjs", import.meta.url));
      assert.deepEqual(await readFile(sessionStartScriptPath(join(harness.home, skillPath))), scriptTemplate);
    }
    const mutations = (await harness.calls()).filter(call => ["remove", "add", "login"].includes(call[2]) && !call.includes("--help"));
    assert.deepEqual(mutations, [
      ["claude", "mcp", "add", "--transport", "http", "--scope", "user", "backchannels", url],
      ["claude", "mcp", "login", "backchannels"],
      ["codex", "mcp", "add", "backchannels", "--url", url],
      ["agent", "mcp", "login", "backchannels"],
    ]);
    for (const call of mutations) assert.ok(output.stdout.includes(call.join(" ")));
  } finally { await harness.close(); }
});

test("Claude and Codex get a SessionStart hook that prints the versioned session-start text", async () => {
  const harness = await createHarness();
  try {
    const output = await harness.invoke(["--yes"], terminalWithBrowser);
    assert.equal(output.code, 0, output.stdout + output.stderr);
    assert.match(output.stdout, /open \/hooks in Codex once and trust the backchannels SessionStart hook/);
    for (const settingsPath of [join(harness.home, claudeHookSettings), join(harness.codexConfig, "..", "hooks.json")]) {
      const [command, ...otherCommands] = await sessionStartCommands(settingsPath);
      assert.deepEqual(otherCommands, []);
      const hookOutput = await run(["/bin/sh", "-c", `PATH=/usr/bin:/bin; ${command}`]);
      assert.equal(hookOutput.code, 0);
      assert.match(hookOutput.stdout, /register_agent/);
      assert.ok(hookOutput.stdout.includes(`skill_version "${packageVersion}"`));
    }
    assert.equal(await exists(join(harness.home, ".cursor/settings.json")), false);
  } finally { await harness.close(); }
});

test("a SessionStart hook whose text file is gone prints nothing and succeeds", async () => {
  const harness = await createHarness(["claude"]);
  try {
    assert.equal((await harness.invoke(["--yes", "--agent", "claude"])).code, 0);
    const [command] = await sessionStartCommands(join(harness.home, claudeHookSettings));
    await rm(join(harness.home, ".claude/skills/backchannels"), { recursive: true });
    const hookOutput = await run(["/bin/sh", "-c", `PATH=/usr/bin:/bin; ${command}`]);
    assert.deepEqual([hookOutput.code, hookOutput.stdout, hookOutput.stderr], [0, "", ""]);
  } finally { await harness.close(); }
});

test("the installer upgrades cat-only hooks and status recognizes the script command", async () => {
  const harness = await createHarness();
  try {
    const placements = [
      { agent: "claude" as const, skillPath: join(harness.home, claudeSkill), settingsPath: join(harness.home, claudeHookSettings) },
      { agent: "codex" as const, skillPath: join(harness.home, sharedSkill), settingsPath: join(harness.codexConfig, "..", "hooks.json") },
    ];
    for (const { agent, skillPath, settingsPath } of placements) {
      const oldCommand = `cat '${sessionStartTextPath(skillPath)}' 2>/dev/null || true`;
      await seedFile(settingsPath, JSON.stringify({ hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: oldCommand }, { type: "command", command: "echo foreign" }] }] } }));
      assert.equal(await readSessionHookInstalled(agent, { readPaths: [skillPath], installPath: skillPath }), false);
    }
    assert.equal((await harness.invoke(["--yes"], terminalWithBrowser)).code, 0);
    for (const { agent, skillPath, settingsPath } of placements) {
      assert.deepEqual(await sessionStartCommands(settingsPath), [sessionHookCommand(sessionStartTextPath(skillPath)), "echo foreign"]);
      assert.equal(await readSessionHookInstalled(agent, { readPaths: [skillPath], installPath: skillPath }), true);
    }
    const status = await harness.invoke(["status"]);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /claude: .*session hook installed/);
    assert.match(status.stdout, /codex: .*session hook installed/);
  } finally { await harness.close(); }
});

test("foreign Claude settings and hooks survive the SessionStart hook merge", async () => {
  const harness = await createHarness();
  try {
    const foreignSettings = { model: "opus", hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo foreign" }] }] } };
    await seedFile(join(harness.home, claudeHookSettings), JSON.stringify(foreignSettings));
    assert.equal((await harness.invoke(["--yes"])).code, 0);
    const settings = JSON.parse(await readFile(join(harness.home, claudeHookSettings), "utf8"));
    assert.equal(settings.model, "opus");
    assert.deepEqual(settings.hooks.SessionStart[0], foreignSettings.hooks.SessionStart[0]);
    assert.equal(settings.hooks.SessionStart.length, 2);
    assert.deepEqual(JSON.parse(await readFile(join(harness.home, `${claudeHookSettings}.backchannels.bak`), "utf8")), foreignSettings);
  } finally { await harness.close(); }
});

test("malformed Claude settings fail only the SessionStart hook and leave the settings untouched", async () => {
  const harness = await createHarness(["claude"]);
  try {
    const malformedSettings = "{ not json";
    await seedFile(join(harness.home, claudeHookSettings), malformedSettings);
    const output = await harness.invoke(["--yes", "--agent", "claude"]);
    assert.equal(output.code, 1, output.stdout + output.stderr);
    assert.match(output.stderr, /claude: plan session hook failed/);
    assert.match(output.stdout, /claude: registered, .*skill version .*, session hook unreadable/);
    assert.equal((await harness.state()).claude.url, url);
    assert.equal(await exists(join(harness.home, claudeSkill)), true);
    assert.match(output.stderr, /settings\.json: Refusing to change hook settings: invalid JSON/);
    assert.doesNotMatch(output.stderr, /SyntaxError|at JSON\.parse/);
    assert.equal(await exists(join(harness.home, `${claudeHookSettings}.backchannels.bak`)), false);
    assert.equal(await readFile(join(harness.home, claudeHookSettings), "utf8"), malformedSettings);
  } finally { await harness.close(); }
});

test("second run rewrites no file and performs no registration and no login except Cursor's", async () => {
  const harness = await createHarness();
  try {
    assert.equal((await harness.invoke(["--yes"], terminalWithBrowser)).code, 0);
    const snapshot = await snapshotFiles(harness.home);
    await writeFile(harness.callsPath, "");
    const output = await harness.invoke(["--yes"], terminalWithBrowser);
    assert.equal(output.code, 0, output.stderr);
    assert.match(output.stdout, /already installed/);
    assert.deepEqual(await snapshotFiles(harness.home), snapshot);
    const mutations = (await harness.calls()).filter(call => ["add", "remove", "login", "logout"].includes(call[2]) && !call.includes("--help"));
    assert.deepEqual(mutations, [["agent", "mcp", "login", "backchannels"]]);
  } finally { await harness.close(); }
});

test("foreign TOML servers and comments and Cursor servers survive merges", async () => {
  const harness = await createHarness();
  try {
    const foreign = '# retained comment\n[mcp_servers.foreign]\nurl = "https://foreign.test"\n\n# another comment\n[preferences]\ntheme = "dark"\n';
    await seedFile(harness.codexConfig, foreign);
    await seedFile(harness.cursorConfig, '{"mcpServers":{"foreign":{"url":"https://foreign.test"}},"theme":"dark"}');
    const output = await harness.invoke(["--yes"], { isInteractive: false, canOpenBrowser: false });
    assert.equal(output.code, 0, output.stderr);
    assert.ok((await readFile(harness.codexConfig, "utf8")).startsWith(foreign));
    assert.deepEqual(JSON.parse(await readFile(harness.cursorConfig, "utf8")).mcpServers.foreign, { url: "https://foreign.test" });
    assert.equal(await readFile(`${harness.codexConfig}.backchannels.bak`, "utf8"), foreign);
  } finally { await harness.close(); }
});

test("symlinked Cursor configuration is written through the link", async () => {
  const harness = await createHarness(["agent"]);
  try {
    const target = join(harness.home, "managed.json");
    await writeFile(target, '{"mcpServers":{"foreign":{"url":"https://foreign.test"}}}');
    await mkdir(join(harness.home, ".cursor"));
    await symlink(target, harness.cursorConfig);
    assert.equal((await harness.invoke(["--yes"])).code, 0);
    assert.equal((await lstat(harness.cursorConfig)).isSymbolicLink(), true);
    assert.equal(JSON.parse(await readFile(target, "utf8")).mcpServers.backchannels.url, url);
  } finally { await harness.close(); }
});

test("Codex without its CLI reads and merges its configured home", async () => {
  const harness = await createHarness([]);
  try {
    await mkdir(join(harness.codexConfig, ".."), { recursive: true });
    const output = await harness.invoke(["--yes"]);
    assert.equal(output.code, 0, output.stderr);
    assert.match(output.stdout, /Codex signs in on first use/);
    assert.match(await readFile(harness.codexConfig, "utf8"), /\[mcp_servers.backchannels\]/);
    assert.deepEqual(await harness.calls(), []);
  } finally { await harness.close(); }
});

test("without a browser Codex merges TOML and prints every login command", async () => {
  const harness = await createHarness();
  try {
    const output = await harness.invoke(["--yes"], { isInteractive: false, canOpenBrowser: false });
    assert.equal(output.code, 0, output.stderr);
    assert.match(output.stdout, /claude mcp login backchannels/);
    assert.match(output.stdout, /codex mcp login backchannels --no-browser/);
    assert.match(output.stdout, /agent mcp login backchannels/);
    assert.equal((await harness.calls()).some(call => call[0] === "codex" && call[2] === "add" && !call.includes("--help")), false);
    assert.equal((await harness.calls()).some(call => call[2] === "login" && !call.includes("--help")), false);
  } finally { await harness.close(); }
});

test("Cursor only receives exactly one shared skill", async () => {
  const harness = await createHarness(["agent"]);
  try {
    assert.equal((await harness.invoke(["--yes"])).code, 0);
    assert.equal(await exists(join(harness.home, ".agents/skills/backchannels/SKILL.md")), true);
    assert.equal(await exists(join(harness.home, ".claude")), false);
    assert.equal(await exists(join(harness.home, ".cursor/skills")), false);
  } finally { await harness.close(); }
});

test("agent selection limits both commands and skill writes", async () => {
  const harness = await createHarness();
  try {
    const output = await harness.invoke(["--yes", "--agent", "claude"]);
    assert.equal(output.code, 0, output.stderr);
    assert.equal(await exists(harness.codexConfig), false);
    assert.equal(await exists(harness.cursorConfig), false);
    assert.equal(await exists(join(harness.home, ".agents")), false);
    const isProbe = (call: string[]) => call.includes("--help") || call[1] === "--version";
    assert.equal((await harness.calls()).some(call => call[0] !== "claude" && !isProbe(call)), false);
  } finally { await harness.close(); }
});

test("dry run lists commands and files without writing anything", async () => {
  const harness = await createHarness();
  try {
    const snapshot = await snapshotFiles(harness.home);
    const output = await harness.invoke(["--dry-run"]);
    assert.equal(output.code, 0, output.stderr);
    assert.match(output.stdout, /SKILL.md/);
    assert.match(output.stdout, /config.toml/);
    assert.doesNotMatch(output.stdout, /codex mcp add/);
    assert.deepEqual(await snapshotFiles(harness.home), snapshot);
    assert.equal((await harness.state()).claude.url, undefined);
  } finally { await harness.close(); }
});

test("noninteractive install without yes refuses before any mutation", async () => {
  const harness = await createHarness();
  try {
    const output = await harness.invoke();
    assert.equal(output.code, 1);
    assert.match(output.stderr, /TTY.*--yes/);
    assert.deepEqual(await readdir(harness.home), []);
  } finally { await harness.close(); }
});

test("written installer files contain no credential values or prohibited copy", async () => {
  const harness = await createHarness();
  try {
    await harness.setState({ claude: {}, codex: {}, cursor: {}, agentVersion: "Cursor token-sensitive-do-not-copy" });
    assert.equal((await harness.invoke(["--yes"])).code, 0);
    for (const path of Object.keys(await snapshotFiles(harness.home))) {
      const content = await readFile(path, "utf8");
      assert.doesNotMatch(content, /token-sensitive-do-not-copy|access_token|refresh_token|client_secret|s[l]ack/i);
    }
  } finally { await harness.close(); }
});

test("status reports registration, sign-in and installed package version", async () => {
  const harness = await createHarness();
  try {
    assert.equal((await harness.invoke(["--yes"], terminalWithBrowser)).code, 0);
    const snapshot = await snapshotFiles(harness.home);
    const output = await harness.invoke(["status"]);
    assert.equal(output.code, 0, output.stderr);
    assert.match(output.stdout, new RegExp(`claude: registered, signed in, skill version ${packageVersion.replaceAll(".", "\\.")}, session hook installed`));
    assert.match(output.stdout, new RegExp(`codex: registered, signed in, skill version ${packageVersion.replaceAll(".", "\\.")}`));
    assert.match(output.stdout, new RegExp(`cursor: registered, sign-in unknown, skill version ${packageVersion.replaceAll(".", "\\.")}`));
    assert.deepEqual(await snapshotFiles(harness.home), snapshot);
  } finally { await harness.close(); }
});

test("status reads legacy top-level versions alongside metadata versions", async () => {
  const harness = await createHarness();
  try {
    assert.equal((await harness.invoke(["--yes"], terminalWithBrowser)).code, 0);
    await seedFile(join(harness.home, claudeSkill), '---\nversion: "0.1.1"\n---\n');
    const snapshot = await snapshotFiles(harness.home);
    const output = await harness.invoke(["status"]);
    assert.equal(output.code, 0, output.stderr);
    assert.match(output.stdout, /claude: registered, signed in, skill version 0\.1\.1/);
    assert.ok(output.stdout.includes(`codex: registered, signed in, skill version ${packageVersion}`));
    assert.deepEqual(await snapshotFiles(harness.home), snapshot);
  } finally { await harness.close(); }
});

test("one failed agent does not stop the others and names the failing step", async () => {
  const harness = await createHarness();
  try {
    await harness.setState({ claude: {}, codex: {}, cursor: {}, failing: ["claude:add"] });
    const output = await harness.invoke(["--yes"]);
    assert.equal(output.code, 1);
    assert.match(output.stderr, /claude.*add[\s\S]*no backchannels entry.*rerun/i);
    assert.match(await readFile(harness.codexConfig, "utf8"), /mcp_servers.backchannels/);
    assert.equal(JSON.parse(await readFile(harness.cursorConfig, "utf8")).mcpServers.backchannels.url, url);
  } finally { await harness.close(); }
});

test("usage errors exit two", async () => {
  const harness = await createHarness();
  try {
    for (const arguments_ of [["--agent", "unknown"], ["unknown"], ["uninstall"], ["--unknown"], ["install", "status"]]) {
      assert.equal((await harness.invoke(arguments_)).code, 2);
    }
  } finally { await harness.close(); }
});

test("a generic agent executable is never used as Cursor", async () => {
  const harness = await createHarness(["agent"]);
  try {
    await harness.setState({ claude: {}, codex: {}, cursor: {}, agentVersion: "Generic Agent" });
    await mkdir(join(harness.home, ".cursor"));
    const output = await harness.invoke(["--yes"]);
    assert.equal(output.code, 0, output.stderr);
    assert.match(output.stdout, /Cursor asks to sign in on first use/);
    assert.equal((await harness.calls()).some(call => call[0] === "agent" && call[1] === "mcp"), false);
  } finally { await harness.close(); }
});

test("without a TTY Claude is registered, prints its login command and is not a failure", async () => {
  const harness = await createHarness(["claude"]);
  try {
    const output = await harness.invoke(["--yes"], { isInteractive: false, canOpenBrowser: true });
    assert.equal(output.code, 0, output.stderr);
    assert.match(output.stdout, /Sign in from a terminal: claude mcp login backchannels/);
    assert.match(output.stdout, new RegExp(`claude: registered, not signed in, skill version ${packageVersion.replaceAll(".", "\\.")}`));
    assert.equal((await harness.calls()).some(call => call[2] === "login" && !call.includes("--help")), false);
  } finally { await harness.close(); }
});

test("a failed Claude login still installs the skill and names the login command to rerun", async () => {
  const harness = await createHarness(["claude"]);
  try {
    await harness.setState({ claude: {}, codex: {}, cursor: {}, failing: ["claude:login"] });
    const output = await harness.invoke(["--yes"], terminalWithBrowser);
    assert.equal(output.code, 1);
    assert.match(output.stderr, /claude: claude mcp login backchannels failed: .*Sign in from a terminal: claude mcp login backchannels/);
    assert.equal(await exists(join(harness.home, claudeSkill)), true);
    assert.match(output.stdout, new RegExp(`claude: registered, not signed in, skill version ${packageVersion.replaceAll(".", "\\.")}`));
  } finally { await harness.close(); }
});

test("Claude removes only an existing entry with a different URL", async () => {
  const harness = await createHarness(["claude"]);
  try {
    await harness.setState({ claude: { url: "https://old.test" }, codex: {}, cursor: {} });
    assert.equal((await harness.invoke(["--yes"])).code, 0);
    const mutations = (await harness.calls()).filter(call => ["remove", "add"].includes(call[2]) && !call.includes("--help"));
    assert.deepEqual(mutations.map(call => call[2]), ["remove", "add"]);
    assert.equal((await harness.state()).claude.url, url);
  } finally { await harness.close(); }
});

test("selecting Cursor on a machine with every agent writes no skill", async () => {
  const harness = await createHarness();
  try {
    const output = await harness.invoke(["--yes", "--agent", "cursor"]);
    assert.equal(output.code, 0, output.stderr);
    assert.equal(JSON.parse(await readFile(harness.cursorConfig, "utf8")).mcpServers.backchannels.url, url);
    assert.equal(await exists(join(harness.home, sharedSkill)), false);
    assert.equal(await exists(join(harness.home, claudeSkill)), false);
  } finally { await harness.close(); }
});

test("new skill files are world readable and existing ones keep their mode", async () => {
  const harness = await createHarness(["claude"]);
  try {
    await seedFile(join(harness.home, claudeSkill), "---\nversion: \"-1\"\n---\n");
    await chmod(join(harness.home, claudeSkill), 0o600);
    await mkdir(join(harness.codexConfig, ".."), { recursive: true });
    assert.equal((await harness.invoke(["--yes"])).code, 0);
    assert.equal((await stat(join(harness.home, claudeSkill))).mode & 0o777, 0o600);
    assert.equal((await stat(join(harness.home, sharedSkill))).mode & 0o777, 0o644);
  } finally { await harness.close(); }
});

test("the browser registration path backs up config.toml before the client rewrites it", async () => {
  const harness = await createHarness();
  try {
    const foreign = '[mcp_servers.foreign]\nurl = "https://foreign.test"\n';
    await seedFile(harness.codexConfig, foreign);
    assert.equal((await harness.invoke(["--yes"], terminalWithBrowser)).code, 0);
    const backup = `${harness.codexConfig}.backchannels.bak`;
    assert.equal(await readFile(backup, "utf8"), foreign);
    assert.equal((await stat(backup)).mode & 0o777, 0o600);
  } finally { await harness.close(); }
});

test("an unselected agent whose presence check throws does not abort a selected install", async () => {
  const harness = await createHarness(["claude"]);
  try {
    const regularFile = join(harness.directory, "codex-home-file");
    await writeFile(regularFile, "");
    process.env.CODEX_HOME = join(regularFile, "codex");
    const output = await harness.invoke(["--yes", "--agent", "claude"]);
    assert.equal(output.code, 0, output.stderr);
    assert.match(output.stderr, /codex: detect failed/);
    assert.equal((await harness.state()).claude.url, url);
  } finally { await harness.close(); }
});

test("an inline backchannels TOML entry fails that agent with a hand-edit message", async () => {
  const harness = await createHarness(["claude"]);
  try {
    const inline = '[mcp_servers]\nbackchannels = { url = "https://old.test" }\n';
    await seedFile(harness.codexConfig, inline);
    const output = await harness.invoke(["--yes"]);
    assert.equal(output.code, 1);
    assert.match(output.stderr, /codex: plan failed: .*edit that entry by hand/);
    assert.equal(await readFile(harness.codexConfig, "utf8"), inline);
    assert.equal((await harness.state()).claude.url, url);
  } finally { await harness.close(); }
});

test("a Cursor rerun after a failed login runs the login again in a terminal with a browser", async () => {
  const harness = await createHarness(["agent"]);
  try {
    await harness.setState({ claude: {}, codex: {}, cursor: {}, failing: ["agent:login"] });
    assert.equal((await harness.invoke(["--yes"], terminalWithBrowser)).code, 1);
    await harness.setState({ ...await harness.state(), failing: [] });
    await writeFile(harness.callsPath, "");
    const output = await harness.invoke(["--yes"], terminalWithBrowser);
    assert.equal(output.code, 0, output.stderr);
    assert.doesNotMatch(output.stdout, /sign-in state is unknown/);
    const logins = (await harness.calls()).filter(call => call[2] === "login" && !call.includes("--help"));
    assert.deepEqual(logins, [["agent", "mcp", "login", "backchannels"]]);
  } finally { await harness.close(); }
});

test("a Cursor install without a TTY prints the login command without running it", async () => {
  const harness = await createHarness(["agent"]);
  try {
    const output = await harness.invoke(["--yes"]);
    assert.equal(output.code, 0, output.stderr);
    assert.match(output.stdout, /Sign in from a terminal: agent mcp login backchannels/);
    assert.equal((await harness.calls()).some(call => call[2] === "login" && !call.includes("--help")), false);
  } finally { await harness.close(); }
});
