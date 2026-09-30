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

test("an older backchannels command updates in place and preserves carbon unit edits", () => {
  const staleCommand = "cat '/old/skills/backchannels/session-start.txt'";
  const sharedGroup = { matcher: "startup", custom: true, hooks: [{ type: "command", command: staleCommand, timeout: 37, async: true }, { type: "command", command: "echo kept" }] };
  const staleOnlyGroup = { matcher: "resume", hooks: [{ type: "command", command: staleCommand, timeout: 12 }] };
  const settings = JSON.parse(setSessionHook(JSON.stringify({ hooks: { SessionStart: [sharedGroup, staleOnlyGroup] } }), command));
  assert.deepEqual(settings.hooks.SessionStart, [
    { ...sharedGroup, hooks: [{ ...sharedGroup.hooks[0], command }, sharedGroup.hooks[1]] },
    { ...staleOnlyGroup, hooks: [{ ...staleOnlyGroup.hooks[0], command }] },
  ]);
  const updated = JSON.stringify(settings);
  assert.equal(setSessionHook(updated, command), updated);
});

test("paths with quotes stay one shell argument", () => {
  assert.equal(sessionHookCommand("/home/o'brien/session-start.txt"), `cat '/home/o'\\''brien/session-start.txt' 2>/dev/null || true`);
});

test("malformed hook settings are refused instead of overwritten", () => {
  for (const source of ["[]", '{"hooks":[]}', '{"hooks":{"SessionStart":{}}}', "not json"]) {
    assert.throws(() => setSessionHook(source, command));
  }
});

test("a current handler beside a stale handler leaves exactly one backchannels handler", () => {
  const handlers = [{ type: "command", command, timeout: 8 }, { type: "command", command: "cat '/old/backchannels/session-start.txt'", timeout: 19 }, foreignGroup.hooks[0]];
  const settings = JSON.parse(setSessionHook(JSON.stringify({ hooks: { SessionStart: [{ matcher: "resume", hooks: handlers }] } }), command));
  assert.deepEqual(settings.hooks.SessionStart, [{ matcher: "resume", hooks: [handlers[0], foreignGroup.hooks[0]] }]);
  assert.equal(setSessionHook(JSON.stringify(settings), command), JSON.stringify(settings));
});

test("startup and resume groups each holding a backchannels handler merge into one handler matching both events", () => {
  const startupGroup = { matcher: "startup", hooks: [{ type: "command", command, timeout: 9 }] };
  const resumeGroup = { matcher: "resume", hooks: [{ type: "command", command: "cat '/old/backchannels/session-start.txt'" }] };
  const settings = JSON.parse(setSessionHook(JSON.stringify({ hooks: { SessionStart: [startupGroup, resumeGroup] } }), command));
  assert.deepEqual(settings.hooks.SessionStart, [{ matcher: "startup|resume", hooks: [startupGroup.hooks[0]] }]);
  assert.equal(setSessionHook(JSON.stringify(settings), command), JSON.stringify(settings));
});

test("a later match-all group widens a kept group that has no foreign handlers to match all", () => {
  const startupGroup = { matcher: "startup", hooks: [{ type: "command", command }] };
  const allGroup = { hooks: [{ type: "command", command }] };
  const settings = JSON.parse(setSessionHook(JSON.stringify({ hooks: { SessionStart: [startupGroup, allGroup] } }), command));
  assert.deepEqual(settings.hooks.SessionStart, [{ matcher: "", hooks: [startupGroup.hooks[0]] }]);
});

test("a later group whose events are already covered is dropped without rewriting the kept matcher", () => {
  const keptGroup = { matcher: "startup|resume", hooks: [{ type: "command", command }] };
  const coveredGroup = { matcher: "resume", hooks: [{ type: "command", command }] };
  const settings = JSON.parse(setSessionHook(JSON.stringify({ hooks: { SessionStart: [keptGroup, coveredGroup] } }), command));
  assert.deepEqual(settings.hooks.SessionStart, [keptGroup]);
});

test("a kept group shared with a foreign handler is never widened, so the later backchannels group stays on its own", () => {
  const sharedGroup = { matcher: "startup", hooks: [{ type: "command", command }, foreignGroup.hooks[0]] };
  const resumeGroup = { matcher: "resume", hooks: [{ type: "command", command }] };
  const source = JSON.stringify({ hooks: { SessionStart: [sharedGroup, resumeGroup] } });
  assert.equal(setSessionHook(source, command), source);
});

function mergeTwice(groups: unknown[]): { once: { hooks: { SessionStart: unknown[] } }; rerunSource: string; rerunResult: string } {
  const once = setSessionHook(JSON.stringify({ hooks: { SessionStart: groups } }), command);
  return { once: JSON.parse(once), rerunSource: once, rerunResult: setSessionHook(once, command) };
}

test("a kept match-all star group absorbs a later plain group unchanged", () => {
  const keptGroup = { matcher: "*", hooks: [{ type: "command", command }] };
  const laterGroup = { matcher: "resume", hooks: [{ type: "command", command }] };
  const { once, rerunSource, rerunResult } = mergeTwice([keptGroup, laterGroup]);
  assert.deepEqual(once.hooks.SessionStart, [keptGroup]);
  assert.equal(rerunResult, rerunSource);
});

test("a later match-all star group makes a kept plain list match all with a star", () => {
  const keptGroup = { matcher: "startup", hooks: [{ type: "command", command }] };
  const laterGroup = { matcher: "*", hooks: [{ type: "command", command }] };
  const { once, rerunSource, rerunResult } = mergeTwice([keptGroup, laterGroup]);
  assert.deepEqual(once.hooks.SessionStart, [{ matcher: "*", hooks: [keptGroup.hooks[0]] }]);
  assert.equal(rerunResult, rerunSource);
});

test("a regex matcher is never merged, so both groups stay with current commands", () => {
  const staleCommand = "cat '/old/backchannels/session-start.txt'";
  const keptGroup = { matcher: "^(startup|resume)$", hooks: [{ type: "command", command: staleCommand }] };
  const laterGroup = { matcher: "clear", hooks: [{ type: "command", command: staleCommand }] };
  const { once, rerunSource, rerunResult } = mergeTwice([keptGroup, laterGroup]);
  assert.deepEqual(once.hooks.SessionStart, [
    { matcher: "^(startup|resume)$", hooks: [{ type: "command", command }] },
    { matcher: "clear", hooks: [{ type: "command", command }] },
  ]);
  assert.equal(rerunResult, rerunSource);
});
