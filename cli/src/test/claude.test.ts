import { test } from "node:test";
import assert from "node:assert/strict";
import { prepare } from "../commands/shared.js";
import { writeFile } from "node:fs/promises";
import { createHarness, readOutputFixture } from "./harness.js";
import { parseClaudeRegistration, parseClaudeSignIn } from "../clients/claude.js";

const captured = 'backchannels:\n  Scope: User config (available in all your projects)\n  Status: ✔ Connected\n  Type: http\n  URL: https://api.backchannels.dev/mcp\n';

test("Claude parses the captured registration and connected status", () => {
  assert.deepEqual(parseClaudeRegistration(captured), { url: "https://api.backchannels.dev/mcp" });
  assert.equal(parseClaudeSignIn(captured), "signed-in");
  assert.equal(parseClaudeSignIn(captured.replace("✔ Connected", "✘ Disconnected")), "signed-out");
  assert.equal(parseClaudeSignIn(""), "unknown");
  assert.deepEqual(parseClaudeRegistration('No MCP server named "backchannels".'), {});
});

test("Claude replays captured output with one get and one capability probe per invocation", async () => {
  const harness = await createHarness(["claude"]);
  try {
    await harness.setState({ claude: { url: "https://api.backchannels.dev/mcp", signedIn: true }, codex: {}, cursor: {}, outputs: { "claude:get": { code: 0, stdout: await readOutputFixture("claude-connected.txt"), stderr: "" } } });
    for (let invocation = 0; invocation < 2; invocation++) {
      await writeFile(harness.callsPath, "");
      const output = await harness.invoke(["--dry-run"]);
      assert.equal(output.code, 0, output.stderr);
      const calls = await harness.calls();
      assert.equal(calls.filter(call => call[2] === "get" && !call.includes("--help")).length, 1);
      assert.equal(calls.filter(call => call.includes("--help")).length, 4);
      assert.deepEqual(calls.filter(call => call[2] === "login" && !call.includes("--help")), []);
    }
  } finally { await harness.close(); }
});

test("changed Claude status text degrades to unknown without a spurious login", async () => {
  const harness = await createHarness(["claude"]);
  try {
    const capturedOutput = await readOutputFixture("claude-status-variant.txt");
    assert.equal(parseClaudeSignIn(capturedOutput), "unknown");
    assert.equal(parseClaudeSignIn(capturedOutput.replace("Connection healthy", "✘ Connection healthy")), "unknown");
    await harness.setState({ claude: { url: "https://api.backchannels.dev/mcp", signedIn: true }, codex: {}, cursor: {}, outputs: { "claude:get": { code: 0, stdout: capturedOutput, stderr: "" } } });
    const output = await harness.invoke(["--yes"], { isInteractive: true, canOpenBrowser: true });
    assert.equal(output.code, 0, output.stderr);
    assert.match(output.stdout, /Claude sign-in state is unknown/);
    assert.match(output.stdout, /claude: registered, sign-in unknown/);
    assert.deepEqual((await harness.calls()).filter(call => ["add", "remove", "login"].includes(call[2]) && !call.includes("--help")), []);
  } finally { await harness.close(); }
});

test("Claude verification refreshes the cached output after registration and login", async () => {
  const harness = await createHarness(["claude"]);
  try {
    const output = await harness.invoke(["--yes"], { isInteractive: true, canOpenBrowser: true });
    assert.equal(output.code, 0, output.stderr);
    assert.match(output.stdout, /claude: registered, signed in/);
    const calls = await harness.calls();
    assert.equal(calls.filter(call => call[2] === "get" && !call.includes("--help")).length, 2);
    assert.equal(calls.filter(call => call.includes("--help")).length, 4);
    await writeFile(harness.callsPath, "");
    const rerun = await harness.invoke(["--yes"], { isInteractive: true, canOpenBrowser: true });
    assert.equal(rerun.code, 0, rerun.stderr);
    assert.equal((await harness.calls()).filter(call => call[2] === "get" && !call.includes("--help")).length, 1);
  } finally { await harness.close(); }
});

test("changed Claude URL text is refused without modifying the existing registration", async () => {
  const harness = await createHarness(["claude"]);
  try {
    const changedOutput = (await readOutputFixture("claude-connected.txt")).replace("URL:", "Endpoint:");
    assert.deepEqual(parseClaudeRegistration(changedOutput), {});
    for (const stdout of [changedOutput, ""]) {
      await writeFile(harness.callsPath, "");
      await harness.setState({ claude: { url: "https://api.backchannels.dev/mcp", signedIn: true }, codex: {}, cursor: {}, outputs: { "claude:get": { code: 0, stdout, stderr: "" } } });
      const output = await harness.invoke(["--yes"], { isInteractive: true, canOpenBrowser: true });
      assert.equal(output.code, 1);
      assert.match(output.stderr, /Cannot read the Claude server URL; refusing to change its registration/);
      assert.doesNotMatch(output.stderr, /Unhandled|at .*\.js/);
      assert.deepEqual((await harness.calls()).filter(call => ["add", "remove", "login"].includes(call[2]) && !call.includes("--help")), []);
    }
  } finally { await harness.close(); }
});

test("Claude read caches do not survive another invocation in the same process", async () => {
  const harness = await createHarness(["claude"]);
  try {
    const machine = { isInteractive: true, canOpenBrowser: true };
    const options = { yes: true, dryRun: true, agent: "claude" as const };
    await harness.setState({ claude: { url: "https://api.backchannels.dev/mcp", signedIn: true }, codex: {}, cursor: {} });
    const firstPlan = await prepare(machine, options);
    assert.equal(firstPlan.hasFailures, false);
    assert.equal(firstPlan.clients[0].state.signIn, "signed-in");
    await harness.setState({ claude: { url: "https://api.backchannels.dev/mcp", signedIn: false }, codex: {}, cursor: {}, unsupported: ["claude:login"] });
    const secondPlan = await prepare(machine, options);
    assert.equal(secondPlan.hasFailures, false);
    assert.equal(secondPlan.clients[0].state.detection.supportsCommands, false);
    assert.equal(secondPlan.clients[0].state.signIn, "unknown");
    assert.equal((await harness.calls()).filter(call => call.includes("--help") && call[2] === "login").length, 2);
  } finally { await harness.close(); }
});

test("Claude needs-authentication status parses signed-out and still runs or prints the login step", async () => {
  const needsAuthOutput = await readOutputFixture("claude-needs-auth.txt");
  assert.equal(parseClaudeSignIn(needsAuthOutput), "signed-out");
  for (const symbol of ["✘", "⚠", "✗"]) assert.equal(parseClaudeSignIn(needsAuthOutput.replace("!", symbol)), "signed-out");
  assert.equal(parseClaudeSignIn(needsAuthOutput.replace("! Needs authentication", "✘ Failed to connect")), "signed-out");
  const harness = await createHarness(["claude"]);
  try {
    await harness.setState({ claude: { url: "https://api.backchannels.dev/mcp", signedIn: false }, codex: {}, cursor: {}, outputs: { "claude:get": { code: 0, stdout: needsAuthOutput, stderr: "" } } });
    const nonInteractive = await harness.invoke(["--yes"], { isInteractive: false, canOpenBrowser: true });
    assert.equal(nonInteractive.code, 0, nonInteractive.stderr);
    assert.match(nonInteractive.stdout, /Sign in from a terminal: claude mcp login backchannels/);
    assert.deepEqual((await harness.calls()).filter(call => call[2] === "login" && !call.includes("--help")), []);
    await writeFile(harness.callsPath, "");
    await harness.invoke(["--yes"], { isInteractive: true, canOpenBrowser: true });
    assert.equal((await harness.calls()).filter(call => call[2] === "login" && !call.includes("--help")).length, 1);
  } finally { await harness.close(); }
});
