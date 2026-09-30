import { test } from "node:test";
import assert from "node:assert/strict";
import { hasSessionHook, sessionHookCommand, setSessionHook } from "../session-hook.js";

const command = sessionHookCommand("/home/carbon/.claude/skills/backchannels/session-start.txt");
const foreignGroup = { matcher: "startup", hooks: [{ type: "command", command: "echo foreign" }] };

test("the session hook is appended beside foreign hooks and settings", () => {
  const source = JSON.stringify({ theme: "dark", hooks: { SessionStart: [foreignGroup], Stop: [foreignGroup] } });
  const settings = JSON.parse(setSessionHook(source, command));
  assert.equal(settings.theme, "dark");
  assert.deepEqual(settings.hooks.Stop, [foreignGroup]);
  assert.deepEqual(settings.hooks.SessionStart, [
    foreignGroup,
    { matcher: "startup|resume|clear", hooks: [{ type: "command", command, timeout: 5 }] },
  ]);
});

test("an installed session hook is left alone even after the carbon unit edits its matcher", () => {
  const edited = JSON.stringify({ hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command }] }] } });
  assert.equal(setSessionHook(edited, command), edited);
  assert.equal(hasSessionHook(edited, command), true);
});

test("an older backchannels handler is replaced without dropping handlers that share its group", () => {
  const staleCommand = "cat '/old/skills/backchannels/session-start.txt'";
  const sharedGroup = { matcher: "startup", hooks: [{ type: "command", command: staleCommand }, { type: "command", command: "echo kept" }] };
  const staleOnlyGroup = { hooks: [{ type: "command", command: staleCommand }] };
  const settings = JSON.parse(setSessionHook(JSON.stringify({ hooks: { SessionStart: [sharedGroup, staleOnlyGroup] } }), command));
  assert.deepEqual(settings.hooks.SessionStart, [
    { matcher: "startup", hooks: [{ type: "command", command: "echo kept" }] },
    { matcher: "startup|resume|clear", hooks: [{ type: "command", command, timeout: 5 }] },
  ]);
});

test("paths with quotes stay one shell argument", () => {
  assert.equal(sessionHookCommand("/home/o'brien/session-start.txt"), `cat '/home/o'\\''brien/session-start.txt' 2>/dev/null || true`);
});

test("malformed hook settings are refused instead of overwritten", () => {
  for (const source of ["[]", '{"hooks":[]}', '{"hooks":{"SessionStart":{}}}', "not json"]) {
    assert.throws(() => setSessionHook(source, command));
  }
});
