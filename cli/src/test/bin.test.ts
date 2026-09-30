import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { createHarness } from "./harness.js";
import { run } from "../machine.js";

async function guardOutput(version: string, platform: string): Promise<string> {
  const source = await readFile(new URL("../../bin/backchannels.js", import.meta.url), "utf8");
  let output = "";
  const exit = new Error("expected guard exit");
  assert.throws(() => runInNewContext(source, { process: {
    versions: { node: version }, platform,
    stderr: { write(message: string) { output += message; } },
    exit(code: number) { assert.equal(code, 1); throw exit; },
  } }), error => error === exit);
  return output;
}

test("the Node guard runs before the Windows guard or any import", async () => {
  assert.match(await guardOutput("22.11.0", "win32"), /Node.js 22.12/);
  assert.match(await guardOutput("18.20.0", "linux"), /Node.js 22.12/);
});

test("Windows prints manual setup for each client", async () => {
  const output = await guardOutput("22.12.0", "win32");
  assert.match(output, /Windows is unsupported/);
  assert.match(output, /claude mcp add/);
  assert.match(output, /codex mcp add/);
  assert.match(output, /mcpServers/);
  assert.match(output, /agent mcp login/);
});

test("the bin imports the built installer and returns its usage exit code", async () => {
  const harness = await createHarness([]);
  try {
    const path = fileURLToPath(new URL("../../bin/backchannels.js", import.meta.url));
    const help = await run([process.execPath, path, "--help"]);
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /Usage: backchannels/);
    assert.equal((await run([process.execPath, path, "--unknown"])).code, 2);
  } finally { await harness.close(); }
});
