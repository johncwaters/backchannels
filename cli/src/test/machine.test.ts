import { test } from "node:test";
import assert from "node:assert/strict";
import { symlink, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { createHarness, readOutputFixture } from "./harness.js";
import { createMachine, hasCommand, isMissingServer, run, supportsCommands } from "../machine.js";

test("fake CLIs are found only on the temporary PATH and replay absent servers", async () => {
  const harness = await createHarness();
  try {
    assert.equal(await hasCommand("claude"), true);
    assert.equal(await hasCommand("unavailable"), false);
    assert.equal(await supportsCommands("claude", ["get", "login"]), true);
    const output = await run(["claude", "mcp", "get", "backchannels"]);
    assert.equal(output.code, 1);
    assert.match(output.stderr, /No MCP server named/);
    assert.equal((await harness.calls()).length, 3);
  } finally {
    await harness.close();
  }
});

test("PATH entries that are files or symlink loops are skipped when finding a command", async () => {
  const harness = await createHarness();
  try {
    const regularFile = join(harness.directory, "not-a-directory");
    await writeFile(regularFile, "");
    const symlinkLoop = join(harness.directory, "loop");
    await symlink(symlinkLoop, symlinkLoop);
    process.env.PATH = [regularFile, symlinkLoop, process.env.PATH].join(delimiter);
    assert.equal(await hasCommand("claude"), true);
    assert.equal(await hasCommand("unavailable"), false);
  } finally {
    await harness.close();
  }
});

test("SSH disables the browser even when a display exists", async () => {
  const harness = await createHarness([]);
  try {
    process.env.SSH_CONNECTION = "temporary";
    process.env.DISPLAY = ":1";
    assert.equal(createMachine().canOpenBrowser, false);
    delete process.env.SSH_CONNECTION;
    process.env.SSH_TTY = "/fake/tty";
    assert.equal(createMachine().canOpenBrowser, false);
  } finally {
    await harness.close();
  }
});

test("missing-server detection recognizes captured client errors without hiding changed error text", async () => {
  for (const fixture of ["claude-get-missing.txt", "claude-remove-missing.txt", "codex-get-missing.txt"]) {
    const stderr = await readOutputFixture(fixture);
    assert.equal(isMissingServer({ code: 1, stdout: "", stderr }), true);
    assert.equal(isMissingServer({ code: 3, stdout: "", stderr }), false);
  }
  for (const stderr of ["Error: MCP endpoint backchannels could not be located.", 'No MCP server named "other"', 'No MCP server named "backchannelsx".', 'Authentication failed. No MCP server named "backchannels".']) {
    assert.equal(isMissingServer({ code: 1, stdout: "", stderr }), false);
  }
});

for (const client of ["claude", "codex"]) {
  test(`${client} refuses an unrecognized missing-server error without crashing or logging in`, async () => {
    const harness = await createHarness([client]);
    try {
      await harness.setState({ claude: {}, codex: {}, cursor: {}, outputs: { [`${client}:get`]: { code: 1, stdout: "", stderr: "Error: MCP endpoint backchannels could not be located." } } });
      const output = await harness.invoke(["--yes"], { isInteractive: true, canOpenBrowser: true });
      assert.equal(output.code, 1);
      assert.match(output.stderr, /registration check failed \(exit 1\)/);
      assert.doesNotMatch(output.stderr, /Unhandled|at .*\.js/);
      assert.deepEqual((await harness.calls()).filter(call => ["add", "remove", "login"].includes(call[2]) && !call.includes("--help")), []);
    } finally { await harness.close(); }
  });
}
