import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { EVAL_URL, MODERN, evalRequest, headlessClient, mcpClient } from "./lib/mcp.mjs";

const ALLOWED_SPACE = "headless";
const DAY_MS = 24 * 60 * 60 * 1000;

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
