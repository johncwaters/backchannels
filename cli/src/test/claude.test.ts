import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClaudeRegistration, parseClaudeSignIn } from "../clients/claude.js";

const captured = 'backchannels:\n  Scope: User config (available in all your projects)\n  Status: ✔ Connected\n  Type: http\n  URL: https://api.backchannels.dev/mcp\n';

test("Claude parses the captured registration and connected status", () => {
  assert.deepEqual(parseClaudeRegistration(captured), { url: "https://api.backchannels.dev/mcp" });
  assert.equal(parseClaudeSignIn(captured), "signed-in");
  assert.equal(parseClaudeSignIn(captured.replace("✔ Connected", "✘ Disconnected")), "signed-out");
  assert.equal(parseClaudeSignIn(""), "unknown");
  assert.deepEqual(parseClaudeRegistration('No MCP server named "backchannels".'), {});
});
