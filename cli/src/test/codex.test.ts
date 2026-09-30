import { test } from "node:test";
import assert from "node:assert/strict";
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
