import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createHarness } from "./harness.js";
import { parseCodexRegistration, parseCodexSignIn } from "../clients/codex.js";

const captured = { name: "backchannels", enabled: true, disabled_reason: null, transport: { type: "streamable_http", url: "https://api.backchannels.dev/mcp", bearer_token_env_var: null, http_headers: null, env_http_headers: null, http_headers_helper: null }, enabled_tools: null, disabled_tools: null, startup_timeout_sec: null, tool_timeout_sec: null };

test("Codex parses captured JSON and only OAuth counts as signed in", () => {
  assert.deepEqual(parseCodexRegistration(JSON.stringify(captured)), { url: captured.transport.url });
  for (const authStatus of ["unsupported", "not_logged_in", "o_auth", "bearer_token"]) {
    assert.equal(parseCodexSignIn(JSON.stringify([{ ...captured, auth_status: authStatus }])), authStatus === "o_auth" ? "signed-in" : "signed-out");
  }
  assert.equal(parseCodexSignIn("[]"), "signed-out");
  assert.equal(parseCodexSignIn(JSON.stringify([captured])), "unknown");
  assert.throws(() => parseCodexRegistration("invalid"));
  assert.throws(() => parseCodexSignIn("{}"));
});

for (const hasRegistration of [false, true]) {
  test(`Codex without a TTY ${hasRegistration ? "keeps its registration" : "merges TOML"} and defers sign-in`, async () => {
    const harness = await createHarness(["codex"]);
    try {
      const foreign = '[mcp_servers.foreign]\nurl = "https://foreign.test"\n';
      const current = hasRegistration ? '\n[mcp_servers.backchannels]\nurl = "https://api.backchannels.dev/mcp"\n' : "";
      await mkdir(dirname(harness.codexConfig), { recursive: true });
      await writeFile(harness.codexConfig, foreign + current);
      const output = await harness.invoke(["--yes"]);
      assert.equal(output.code, 0, output.stderr);
      assert.match(output.stdout, /Sign in from a terminal: codex mcp login backchannels/);
      const configuration = await readFile(harness.codexConfig, "utf8");
      assert.ok(configuration.startsWith(foreign));
      assert.match(configuration, /url = "https:\/\/api.backchannels.dev\/mcp"/);
      if (hasRegistration) assert.equal(configuration, foreign + current);
      assert.deepEqual((await harness.calls()).filter(call => ["add", "login"].includes(call[2]) && !call.includes("--help")), []);
      assert.equal((await harness.state()).codex.signedIn, undefined);
    } finally { await harness.close(); }
  });
}
