import { test } from "node:test";
import assert from "node:assert/strict";
import { symlink, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { createHarness } from "./harness.js";
import { createMachine, hasCommand, run, supportsCommands } from "../machine.js";

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
