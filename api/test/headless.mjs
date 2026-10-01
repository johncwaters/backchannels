import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { EVAL_URL, MODERN, cleanupHeadlessAgents, evalRequest, headlessClient, mcpClient } from "./lib/mcp.mjs";

const ALLOWED_SPACE = "headless";
const DAY_MS = 24 * 60 * 60 * 1000;

after(() => cleanupHeadlessAgents());

function seedKey(seed = {}, space = ALLOWED_SPACE) {
  return evalRequest(`/eval/seed-headless?space=${space}`, "POST", seed);
}

async function discoverStatus(key) {
  const response = await fetch(`${EVAL_URL}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MODERN,
      "mcp-method": "server/discover",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} }),
  });
  await response.text();
  return { status: response.status, challenge: response.headers.get("www-authenticate") };
}

describe("headless keys", () => {
  const run = Date.now().toString(36);

  test("a valid key signs in as the workspace owner and gets the suggested name", async () => {
    const { key } = await seedKey({ suggestedName: `hosted-${run}` });
    const client = headlessClient(key);
    const discovered = await client.handshake();
    assert.match(discovered.instructions, new RegExp(`Your agent name is hosted-${run}`));
    const first = await client.call("register_agent", { name: `hosted-${run}`, description: "Headless eval agent" });
    assert.ok(first.ok, first.error);
    assert.equal(first.output.handle, `@headless/hosted-${run}`);
    assert.equal(first.output.created, true);
    const second = await client.call("register_agent", { name: `hosted-${run}` });
    assert.ok(second.ok, second.error);
    assert.equal(second.output.handle, first.output.handle);
    assert.equal(second.output.created, false);
  });

  test("two keys in one workspace land on the same agent", async () => {
    const name = `shared-${run}`;
    const [{ key: firstKey }, { key: secondKey }] = await Promise.all([seedKey(), seedKey()]);
    const first = await headlessClient(firstKey).call("register_agent", { name, description: "Shared headless agent" });
    const second = await headlessClient(secondKey).call("register_agent", { name });
    assert.ok(first.ok && second.ok, first.error ?? second.error);
    assert.equal(second.output.handle, first.output.handle);
  });

  test("a carbon unit whose owner part equals the slug gets a distinct owner", async () => {
    const name = `mailbox-${run}`;
    const namesake = mcpClient("headless", MODERN, ALLOWED_SPACE);
    const registered = await namesake.call("register_agent", { name, description: "Carbon unit named like the workspace" });
    assert.ok(registered.ok, registered.error);
    assert.equal(registered.output.handle, `@headless_/${name}`);
    const actedAs = await namesake.call("check_inbox", { agent: `@headless_/${name}` });
    assert.ok(actedAs.ok, actedAs.error);
    const { key } = await seedKey();
    const headless = await headlessClient(key).call("register_agent", { name, description: "Headless agent with the same name" });
    assert.ok(headless.ok, headless.error);
    assert.equal(headless.output.handle, `@headless/${name}`);
  });

  test("the tool list matches an OAuth session", async () => {
    const { key } = await seedKey();
    const headless = await headlessClient(key).request("tools/list");
    const oauth = await mcpClient(`toolcheck${run}`.slice(0, 40)).request("tools/list");
    assert.deepEqual(headless.tools.map((tool) => tool.name).sort(), oauth.tools.map((tool) => tool.name).sort());
  });

  test("refused keys get 401 invalid_token without a protected resource link", async () => {
    const refusals = {
      unknown: { key: "bc_headless_0000000000000000000000000000zzzz" },
      expired: await seedKey({ expiresInMs: -1000 }),
      revoked: await seedKey({ isRevoked: true }),
      "suspended sponsor": await seedKey({ isSponsorSuspended: true }),
      "stale sponsor": await seedKey({ sponsorVerifiedAgoMs: 8 * DAY_MS }),
      "never verified sponsor": await seedKey({ sponsorVerifiedAgoMs: null }),
      "domain not allowed": await seedKey({}, "offlist"),
    };
    for (const [label, { key }] of Object.entries(refusals)) {
      const { status, challenge } = await discoverStatus(key);
      assert.equal(status, 401, `${label}: expected 401, got ${status}`);
      assert.equal(challenge, 'Bearer error="invalid_token"', `${label}: challenge ${challenge}`);
    }
  });

  test("a sponsor verified six days ago still works", async () => {
    const { key } = await seedKey({ sponsorVerifiedAgoMs: 6 * DAY_MS });
    const discovered = await headlessClient(key).handshake();
    assert.ok(discovered.instructions);
  });

  test("a non-headless bearer still goes to the OAuth server", async () => {
    const { status, challenge } = await discoverStatus("12345:grant:secret");
    assert.equal(status, 401);
    assert.match(challenge ?? "", /resource_metadata=/);
  });

  test("a pasted headless key is refused by the secret scanner", async () => {
    const { key } = await seedKey();
    const client = headlessClient(key);
    const name = `scanner-${run}`;
    assert.ok((await client.call("register_agent", { name, description: "Scanner check" })).ok);
    const channel = `headless-scan-${run}`;
    assert.ok((await client.call("create_channel", { agent: name, name: channel, purpose: "scanner check" })).ok);
    const sent = await client.call("send_message", { agent: name, to: `#${channel}`, text: `the key is ${key}` });
    assert.equal(sent.ok, false);
    assert.match(sent.error, /backchannels headless key/);
  });

  test("calls past the per-agent limit get a retry time", async () => {
    const { key } = await seedKey();
    const client = headlessClient(key);
    const name = `limits-${run}`;
    assert.ok((await client.call("register_agent", { name, description: "Rate limit check" })).ok);
    const channel = `headless-limits-${run}`;
    assert.ok((await client.call("create_channel", { agent: name, name: channel, purpose: "rate limit check" })).ok);
    let refusal;
    for (let attempt = 0; attempt < 40 && !refusal; attempt++) {
      const sent = await client.call("send_message", { agent: name, to: `#${channel}`, text: `rate limit check ${attempt}` });
      if (!sent.ok) refusal = sent.error;
    }
    assert.ok(refusal, "no call was refused");
    assert.match(refusal, /try again|retry/i);
  });
});

function headlessAdmin(op, input, { who = "keyadmin", isAdmin = true, space = ALLOWED_SPACE, verifiedAgoMs = 0 } = {}) {
  return evalRequest(`/eval/headless-admin?space=${space}`, "POST", { op, input, who, isAdmin, verifiedAgoMs });
}

describe("headless key administration", () => {
  const run = Date.now().toString(36);

  test("a carbon unit who is not an admin gets unauthorized", async () => {
    assert.deepEqual(await headlessAdmin("list", {}, { who: "notadmin", isAdmin: false }), { ok: false, error: "unauthorized" });
    const created = await headlessAdmin("create", { label: "x", suggestedName: "x", expiresInDays: 1 }, { who: "notadmin", isAdmin: false });
    assert.deepEqual(created, { ok: false, error: "unauthorized" });
  });

  test("an admin Google has not verified recently cannot create or rotate a key", async () => {
    const input = { label: "Unverified", suggestedName: `unverified-${run}`, expiresInDays: 1 };
    for (const verifiedAgoMs of [null, 8 * DAY_MS]) {
      const options = { who: "staleadmin", verifiedAgoMs };
      assert.deepEqual(await headlessAdmin("create", input, options), { ok: false, error: "sponsor_not_verified" });
    }
    const created = await headlessAdmin("create", input);
    assert.ok(created.ok);
    const rotated = await headlessAdmin("rotate", { keyId: created.value.keyId }, { who: "staleadmin", verifiedAgoMs: null });
    assert.deepEqual(rotated, { ok: false, error: "sponsor_not_verified" });
  });

  test("invalid key fields are refused", async () => {
    for (const input of [
      { label: "", suggestedName: "valid-name", expiresInDays: 30 },
      { label: "x".repeat(81), suggestedName: "valid-name", expiresInDays: 30 },
      { label: "ok", suggestedName: "Not Valid", expiresInDays: 30 },
      { label: "ok", suggestedName: "valid-name", expiresInDays: 91 },
      { label: "ok", suggestedName: "valid-name", expiresInDays: 0 },
    ]) {
      assert.deepEqual(await headlessAdmin("create", input), { ok: false, error: "invalid" }, JSON.stringify(input));
    }
  });

  test("create, rotate, revoke key and revoke agent end to end", async () => {
    const name = `lifecycle-${run}`;
    const created = await headlessAdmin("create", { label: "Lifecycle key", suggestedName: name, expiresInDays: 30 });
    assert.ok(created.ok, JSON.stringify(created));
    assert.match(created.value.key, /^bc_headless_[0-9a-z]{32}$/);
    const first = created.value;
    assert.ok((await headlessClient(first.key).call("register_agent", { name, description: "Lifecycle agent" })).ok);

    const listed = await headlessAdmin("list", {});
    assert.ok(listed.value.keys.some((key) => key.id === first.keyId && key.keyHint === first.key.slice(-4)));
    assert.ok(listed.value.agents.some((agent) => agent.handle === `headless/${name}`));

    const rotated = await headlessAdmin("rotate", { keyId: first.keyId });
    assert.ok(rotated.ok, JSON.stringify(rotated));
    const second = rotated.value;
    assert.ok((await headlessClient(second.key).handshake()).instructions.includes(`Your agent name is ${name}`));
    assert.ok((await headlessClient(first.key).handshake()).instructions, "the rotated key keeps its overlap");
    assert.deepEqual(await headlessAdmin("rotate", { keyId: first.keyId }), { ok: false, error: "already_rotated" });

    const third = (await headlessAdmin("rotate", { keyId: second.keyId })).value;
    assert.equal((await discoverStatus(first.key)).status, 401, "rotating the successor ends the first key's overlap");
    assert.ok((await headlessClient(second.key).handshake()).instructions, "the second key is now in its overlap");

    assert.ok((await headlessAdmin("revokeKey", { keyId: third.keyId })).ok);
    assert.equal((await discoverStatus(third.key)).status, 401);
    assert.deepEqual(await headlessAdmin("revokeKey", { keyId: third.keyId }), { ok: false, error: "not_found" });

    assert.ok((await headlessAdmin("revokeAgent", { handle: `@headless/${name}` })).ok);
    const afterRevoke = await headlessAdmin("list", {});
    assert.ok(!afterRevoke.value.agents.some((agent) => agent.handle === `headless/${name}`));
    const reregistered = await headlessClient(second.key).call("register_agent", { name, description: "again" });
    assert.equal(reregistered.ok, false);
    assert.match(reregistered.error, /revoked/);
  });

  test("an admin of another workspace cannot touch this workspace's keys", async () => {
    const created = await headlessAdmin("create", { label: "Isolation key", suggestedName: `isolation-${run}`, expiresInDays: 1 });
    assert.ok(created.ok);
    const outsider = { who: "outsider", space: "offlist" };
    assert.deepEqual(await headlessAdmin("rotate", { keyId: created.value.keyId }, outsider), { ok: false, error: "not_found" });
    assert.deepEqual(await headlessAdmin("revokeKey", { keyId: created.value.keyId }, outsider), { ok: false, error: "not_found" });
    assert.ok((await headlessClient(created.value.key).handshake()).instructions);
  });
});
