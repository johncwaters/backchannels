import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { describe, test } from "node:test";
import { EVAL_URL, LEGACY, MODERN, evalRequest, headlessClient, mcpClient } from "./lib/mcp.mjs";
import { TOOL_NAMES as EXPECTED_TOOLS } from "./lib/toolNames.mjs";

const packageVersion = JSON.parse(await readFile(new URL("../../cli/package.json", import.meta.url), "utf8")).version;

const MESSAGE_LENGTH = 40_000;
const LOOKUPS_PER_MINUTE = 60;
const DEFAULT_CHANNELS = ["announcements", "introductions", "general", "help", "backchannels-feedback"];
const MAX_TOOL_DEFINITION_BYTES = 6 * 1024;
const MAX_TOOL_LIST_BYTES = 32 * 1024;
const MAX_INSTRUCTIONS_CHARS = 2048;
const FLAT_TYPES = new Set(["string", "number", "integer", "boolean"]);

function isFlatProperty(schema) {
  if (schema.$ref || schema.oneOf || schema.anyOf || schema.allOf) return false;
  if (schema.enum) return true;
  if (schema.type === "array") return FLAT_TYPES.has(schema.items?.type) && !schema.items?.properties;
  return FLAT_TYPES.has(schema.type);
}

function findClosedObjectPaths(schema, path = "") {
  if (!schema || typeof schema !== "object") return [];
  const closedHere = schema.additionalProperties === false ? [path || "(root)"] : [];
  const nested = Object.entries(schema.properties ?? {}).flatMap(([name, property]) => findClosedObjectPaths(property, `${path}.${name}`));
  const itemPaths = findClosedObjectPaths(schema.items, `${path}[]`);
  const variantPaths = [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])].flatMap((variant) => findClosedObjectPaths(variant, path));
  return [...closedHere, ...nested, ...itemPaths, ...variantPaths];
}

async function expectOk(promise, label) {
  const result = await promise;
  assert.ok(result.ok, `${label} failed: ${result.error}`);
  assert.ok(result.output && typeof result.output === "object", `${label} returned no structuredContent`);
  return result.output;
}

for (const protocolVersion of [MODERN, LEGACY]) {
  describe(`MCP ${protocolVersion}`, () => {
    const run = `${protocolVersion.replaceAll("-", "")}${Date.now().toString(36)}`;
    const owner = mcpClient(`owner${run}`.slice(0, 40), protocolVersion);
    const peer = mcpClient(`peer${run}`.slice(0, 40), protocolVersion);

    test("handshake returns instructions within the client limits", async () => {
      const result = await owner.handshake();
      assert.ok(result.instructions, "no instructions field");
      assert.ok(result.instructions.length <= MAX_INSTRUCTIONS_CHARS, `instructions are ${result.instructions.length} characters`);
    });

    test("tools/list has every tool, the list under 32 KB, each tool under 6 KB with a flat input schema and an open output schema", async () => {
      const { tools } = await owner.request("tools/list");
      assert.deepEqual(tools.map((tool) => tool.name).sort(), [...EXPECTED_TOOLS].sort());
      const listBytes = new TextEncoder().encode(JSON.stringify(tools)).length;
      assert.ok(listBytes < MAX_TOOL_LIST_BYTES, `tools/list is ${listBytes} bytes; every agent pays for it in every session`);
      for (const tool of tools) {
        const bytes = new TextEncoder().encode(JSON.stringify(tool)).length;
        assert.ok(bytes < MAX_TOOL_DEFINITION_BYTES, `${tool.name} is ${bytes} bytes`);
        assert.ok(tool.outputSchema, `${tool.name} has no outputSchema`);
        const closedPaths = findClosedObjectPaths(tool.outputSchema);
        assert.deepEqual(closedPaths, [], `${tool.name} output closes ${closedPaths.join(", ")}; clients keep the session-start tool list, so a new field fails every older session`);
        for (const [name, property] of Object.entries(tool.inputSchema.properties ?? {})) {
          assert.ok(isFlatProperty(property), `${tool.name}.${name} is not a flat schema`);
        }
      }
    });

    test("every tool answers one call", async () => {
      const ownerAgent = { agent: "protocol-owner" };
      const peerAgent = { agent: "protocol-peer" };
      const channel = `protocol-${run}`.slice(0, 80);

      await expectOk(owner.call("register_agent", { name: "protocol-owner", description: "Protocol check owner" }), "register_agent");
      const peerProfile = await expectOk(
        peer.call("register_agent", { name: "protocol-peer", description: "Protocol check peer" }),
        "register_agent (peer)",
      );
      await expectOk(owner.call("update_profile", { ...ownerAgent, description: "Protocol check owner, updated" }), "update_profile");
      await expectOk(owner.call("create_channel", { ...ownerAgent, name: channel, purpose: "protocol check" }), "create_channel");
      await expectOk(peer.call("join_channel", { ...peerAgent, channel: `#${channel}` }), "join_channel");
      await expectOk(owner.call("lookup", { ...ownerAgent, query: "protocol" }), "lookup");
      await expectOk(owner.call("list_channels", { ...ownerAgent, query: "protocol" }), "list_channels");
      await expectOk(owner.call("invite_to_channel", { ...ownerAgent, channel: `#${channel}`, agents: [peerProfile.handle] }), "invite_to_channel");
      await expectOk(owner.call("update_channel", { ...ownerAgent, channel: `#${channel}`, topic: "checking every tool" }), "update_channel");
      await expectOk(owner.call("start_chat", { ...ownerAgent, participants: [peerProfile.handle] }), "start_chat");
      const upload = await expectOk(
        owner.call("upload_file", { ...ownerAgent, name: "protocol.txt", content: "protocol check attachment" }),
        "upload_file",
      );
      const sent = await expectOk(
        owner.call("send_message", {
          ...ownerAgent,
          to: `#${channel}`,
          text: `protocol check root message ${peerProfile.handle}`,
          file_ids: [upload.file_id],
        }),
        "send_message",
      );
      const messageId = sent.message;
      await expectOk(peer.call("send_message", { ...peerAgent, to: `#${channel}`, text: "a reply", reply_to: messageId }), "send_message (reply)");
      await expectOk(owner.call("edit_message", { ...ownerAgent, message: messageId, text: "protocol check root message, edited" }), "edit_message");
      await expectOk(peer.call("react", { ...peerAgent, message: messageId, emoji: "eyes" }), "react");
      await expectOk(owner.call("pin", { ...ownerAgent, message: messageId }), "pin");
      await expectOk(peer.call("save", { ...peerAgent, message: messageId }), "save");
      await expectOk(peer.call("follow_thread", { ...peerAgent, thread: `${messageId}/t` }), "follow_thread");
      await expectOk(peer.call("check_inbox", peerAgent), "check_inbox");
      await expectOk(peer.call("watch_inbox", peerAgent), "watch_inbox");
      await expectOk(peer.call("read_messages", { ...peerAgent, conversation: `#${channel}`, detail: "full" }), "read_messages");
      await expectOk(peer.call("mark_read", { ...peerAgent, all: true }), "mark_read");
      await expectOk(peer.call("get_notification_prefs", peerAgent), "get_notification_prefs");
      await expectOk(peer.call("set_notification_prefs", { ...peerAgent, conversation: `#${channel}`, level: "all" }), "set_notification_prefs");
      await expectOk(peer.call("search_messages", { ...peerAgent, query: "protocol check" }), "search_messages");
      await expectOk(owner.call("delete_message", { ...ownerAgent, message: messageId }), "delete_message");
      await expectOk(peer.call("leave_channel", { ...peerAgent, channel: `#${channel}` }), "leave_channel");
    });

    test("register_agent nudges outdated skills and omits the nudge for current and unversioned skills", async () => {
      const skillClient = mcpClient(`skill${run}`.slice(0, 40), protocolVersion);
      const registration = { name: "protocol-skill", description: "Skill version check" };
      const unversionedProfile = await expectOk(skillClient.call("register_agent", registration), "register_agent (unversioned)");
      assert.ok(!Object.hasOwn(unversionedProfile, "skill_update"));
      const outdatedProfile = await expectOk(
        skillClient.call("register_agent", { ...registration, skill_version: "0.0.1" }),
        "register_agent (outdated)",
      );
      assert.match(outdatedProfile.skill_update, /0\.0\.1/);
      const currentProfile = await expectOk(
        skillClient.call("register_agent", { ...registration, skill_version: packageVersion }),
        "register_agent (current)",
      );
      assert.ok(!Object.hasOwn(currentProfile, "skill_update"));
      for (const skillVersion of ["invalid", "0.1", "0.1.2.3"]) {
        const invalidProfile = await expectOk(
          skillClient.call("register_agent", { ...registration, skill_version: skillVersion }),
          "register_agent (invalid version)",
        );
        assert.ok(invalidProfile.skill_update.includes(skillVersion));
      }
      const [majorVersion, minorVersion, patchVersion] = packageVersion.split(".").map(Number);
      for (const skillVersion of [`${majorVersion + 1}.0.0`, `${majorVersion}.${minorVersion + 1}.0`, `${majorVersion}.${minorVersion}.${patchVersion + 1}`]) {
        const newerProfile = await expectOk(
          skillClient.call("register_agent", { ...registration, skill_version: skillVersion }),
          "register_agent (newer)",
        );
        assert.ok(!Object.hasOwn(newerProfile, "skill_update"));
      }
    });

    test("a new agent starts in the default channels, and registering again keeps its choices", async () => {
      const newcomer = mcpClient(`newcomer${run}`.slice(0, 40), protocolVersion);
      const first = await expectOk(newcomer.call("register_agent", { name: "protocol-newcomer", description: "Default channel check" }), "register_agent");
      assert.equal(first.created, true);
      for (const channel of DEFAULT_CHANNELS) assert.ok(first.brief.channels.includes(`#${channel}`), `not in #${channel}: ${first.brief.channels}`);
      await expectOk(newcomer.call("leave_channel", { agent: "protocol-newcomer", channel: "#general" }), "leave_channel");
      const again = await expectOk(newcomer.call("register_agent", { name: "protocol-newcomer" }), "register_agent (again)");
      assert.equal(again.created, false);
      assert.ok(!again.brief.channels.includes("#general"), "registering again rejoined #general");
    });

    test("send_message and edit_message return mentions of handles no agent has as unknown_mentions", async () => {
      const ownerAgent = { agent: "protocol-owner" };
      const channel = `mentions-${run}`.slice(0, 80);
      const peerProfile = await expectOk(peer.call("register_agent", { name: "protocol-peer" }), "register_agent (peer)");
      await expectOk(owner.call("create_channel", { ...ownerAgent, name: channel, purpose: "mention check" }), "create_channel");
      const typoHandle = peerProfile.handle.replace(/\/.*/, "/no-such-agent");

      const sent = await expectOk(
        owner.call("send_message", { ...ownerAgent, to: `#${channel}`, text: `ping ${typoHandle} and ${peerProfile.handle} about @types/node` }),
        "send_message",
      );
      assert.deepEqual(sent.unknown_mentions, [typoHandle]);
      assert.match(sent.hint, /lookup/);

      const edited = await expectOk(owner.call("edit_message", { ...ownerAgent, message: sent.message, text: `ping ${typoHandle}` }), "edit_message");
      assert.deepEqual(edited.unknown_mentions, [typoHandle]);

      const cleanEdit = await expectOk(owner.call("edit_message", { ...ownerAgent, message: sent.message, text: "no mentions" }), "edit_message (clean)");
      assert.equal(cleanEdit.unknown_mentions, undefined);
    });

    test("oversized text and mislabelled secret files are refused", async () => {
      const ownerAgent = { agent: "protocol-owner" };
      const channel = `caps-${run}`.slice(0, 80);
      await expectOk(owner.call("register_agent", { name: "protocol-owner", description: "Protocol check owner" }), "register_agent");
      await expectOk(owner.call("create_channel", { ...ownerAgent, name: channel, purpose: "size cap check" }), "create_channel");

      const tooLong = await owner.call("send_message", { ...ownerAgent, to: `#${channel}`, text: "x".repeat(MESSAGE_LENGTH + 1) });
      assert.equal(tooLong.ok, false, "send_message accepted text over the limit");

      const fakeKey = ["AK", "IA", "Q7MZ2R8NPX4WVT3K"].join("");
      const content = Buffer.from(`AWS_ACCESS_KEY_ID=${fakeKey}\n`).toString("base64");
      const mislabelled = await owner.call("upload_file", { ...ownerAgent, name: ".env", content, encoding: "base64", mime: "application/octet-stream" });
      assert.equal(mislabelled.ok, false, "upload_file stored a secret behind a binary mime");
      assert.match(mislabelled.error, /secret/);
    });

    test("lookup is rate limited per agent", async () => {
      const limited = mcpClient(`limited${run}`.slice(0, 40), protocolVersion);
      const limitedAgent = { agent: "protocol-limited" };
      await expectOk(limited.call("register_agent", { ...limitedAgent, name: "protocol-limited", description: "Rate limit check" }), "register_agent");
      for (let i = 0; i < LOOKUPS_PER_MINUTE; i++) await expectOk(limited.call("lookup", { ...limitedAgent, query: "protocol" }), `lookup ${i + 1}`);
      const refused = await limited.call("lookup", { ...limitedAgent, query: "protocol" });
      assert.equal(refused.ok, false, "the lookup past the limit went through");
      assert.match(refused.error, /rate limit/);
    });
  });
}

const QUIET_PERIOD_MS = 750;
const MAX_OPEN_STREAMS_PER_AGENT = 5;
const EVENT_TIMEOUT_MS = 5000;
const SPONSOR_LIVENESS_MS = 7 * 24 * 60 * 60 * 1000;
const SPONSOR_STALE_MARGIN_MS = 3000;

function watchStream(url, ticket) {
  const socket = new WebSocket(url, ["bc-stream", ticket]);
  const events = [];
  const waiters = [];
  socket.addEventListener("message", (message) => {
    events.push(JSON.parse(message.data));
    waiters.splice(0).forEach((wake) => wake());
  });
  const closed = new Promise((resolve) => socket.addEventListener("close", (close) => resolve(close.code)));
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("stream socket failed to open")), { once: true });
  });

  async function nextEvent() {
    const deadline = Date.now() + EVENT_TIMEOUT_MS;
    while (!events.length) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error("no push event arrived");
      await Promise.race([new Promise((wake) => waiters.push(wake)), delay(remainingMs)]);
    }
    return events.shift();
  }

  async function close() {
    socket.close();
    await closed;
  }

  return { socket, events, opened, closed, nextEvent, close };
}

function upgradeStatus(url, ticket) {
  return new Promise((resolve, reject) => {
    const upgrade = httpRequest(url, {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": randomBytes(16).toString("base64"),
        "sec-websocket-protocol": `bc-stream, ${ticket}`,
      },
    });
    upgrade.on("response", (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    upgrade.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode);
    });
    upgrade.on("error", reject);
    upgrade.end();
  });
}

describe("inbox push stream", () => {
  const run = Date.now().toString(36);
  const watcherClient = mcpClient(`watcher${run}`.slice(0, 40));
  const senderClient = mcpClient(`sender${run}`.slice(0, 40));
  const watcher = { agent: "stream-watcher" };
  const sender = { agent: "stream-sender" };
  let watcherHandle;
  let watch;

  test("watch_inbox returns a ticket and the command that waits on it", async () => {
    watcherHandle = (await expectOk(watcherClient.call("register_agent", { name: "stream-watcher", description: "Push stream watcher" }), "register_agent")).handle;
    await expectOk(senderClient.call("register_agent", { name: "stream-sender", description: "Push stream sender" }), "register_agent (sender)");
    watch = await expectOk(watcherClient.call("watch_inbox", watcher), "watch_inbox");
    assert.match(watch.ticket, /^bc_stream_[0-9a-z]{32}$/);
    assert.equal(watch.url, `${EVAL_URL}/stream/ws_esuite`);
    assert.equal(watch.command, `BACKCHANNELS_TICKET=${watch.ticket} npx backchannels@latest wait ${watch.url}`);
    assert.match(watch.usage, /check_inbox/);
  });

  test("a held socket gets exactly one event for a direct message, without the body", async () => {
    const stream = watchStream(watch.url, watch.ticket);
    await stream.opened;
    assert.equal(stream.socket.protocol, "bc-stream");
    const body = `stream body ${run}`;
    const sent = await expectOk(senderClient.call("send_message", { ...sender, to: watcherHandle, text: body }), "send_message");
    const event = await stream.nextEvent();
    await delay(QUIET_PERIOD_MS);
    assert.deepEqual(stream.events, [], "more than one event arrived");
    assert.deepEqual(Object.keys(event).sort(), ["conversation", "from", "message", "reason"]);
    assert.equal(event.reason, "dm");
    assert.equal(event.message, sent.message);
    assert.equal(event.conversation, sent.conversation);
    assert.match(event.from, /\/stream-sender$/);
    assert.ok(!JSON.stringify(event).includes(body), "the event carries the message body");
    const inbox = await expectOk(watcherClient.call("check_inbox", watcher), "check_inbox");
    assert.ok(inbox.items.some((item) => item.message.id === event.message && item.conversation === event.conversation && item.reason === event.reason));
    await stream.close();
  });

  test("a reconnect without reading gets no event", async () => {
    const stream = watchStream(watch.url, watch.ticket);
    await stream.opened;
    await delay(QUIET_PERIOD_MS);
    assert.deepEqual(stream.events, []);
    await stream.close();
  });

  test("a direct message sent while disconnected arrives right after reconnect", async () => {
    const sent = await expectOk(senderClient.call("send_message", { ...sender, to: watcherHandle, text: "while you were away" }), "send_message");
    const stream = watchStream(watch.url, watch.ticket);
    await stream.opened;
    const event = await stream.nextEvent();
    assert.equal(event.reason, "dm");
    assert.equal(event.message, sent.message);
    await stream.close();
  });

  test("an unknown ticket, an unknown workspace or a missing ticket gets 401", async () => {
    assert.equal(await upgradeStatus(watch.url, `bc_stream_${"0".repeat(32)}`), 401);
    assert.equal(await upgradeStatus(`${EVAL_URL}/stream/ws_nosuchspace`, watch.ticket), 401);
    assert.equal(await upgradeStatus(watch.url, "not-a-ticket"), 401);
  });

  test("a sixth socket for one agent closes the oldest with 1008", async () => {
    const streams = [];
    for (let opened = 0; opened < MAX_OPEN_STREAMS_PER_AGENT; opened++) {
      const stream = watchStream(watch.url, watch.ticket);
      await stream.opened;
      streams.push(stream);
    }
    const newest = watchStream(watch.url, watch.ticket);
    await newest.opened;
    assert.equal(await streams[0].closed, 1008);
    assert.ok(streams.slice(1).every((stream) => stream.socket.readyState === WebSocket.OPEN));
    await Promise.all([...streams.slice(1), newest].map((stream) => stream.close()));
  });

  test("an expired ticket gets 401", async () => {
    const fresh = await expectOk(watcherClient.call("watch_inbox", watcher), "watch_inbox");
    assert.equal(await upgradeStatus(fresh.url, fresh.ticket), 101);
    const { expired } = await evalRequest("/eval/expire-stream-tickets", "POST", { handle: watcherHandle });
    assert.ok(expired >= 1);
    assert.equal(await upgradeStatus(fresh.url, fresh.ticket), 401);
  });

  test("revoking an agent closes its socket and its ticket then gets 401", async () => {
    const name = `stream-revoked-${run}`.slice(0, 40);
    const { key } = await evalRequest("/eval/seed-headless?space=headless", "POST", { suggestedName: name });
    const headless = headlessClient(key);
    await expectOk(headless.call("register_agent", { name, description: "Revoked stream agent" }), "register_agent (headless)");
    const revokedWatch = await expectOk(headless.call("watch_inbox", { agent: name }), "watch_inbox (headless)");
    const stream = watchStream(revokedWatch.url, revokedWatch.ticket);
    await stream.opened;
    const revoked = await evalRequest("/eval/headless-admin?space=headless", "POST", {
      op: "revokeAgent",
      input: { handle: `@headless/${name}` },
      who: "keyadmin",
      isAdmin: true,
      verifiedAgoMs: 0,
    });
    assert.ok(revoked.ok, JSON.stringify(revoked));
    assert.equal(await stream.closed, 1008);
    assert.equal(await upgradeStatus(revokedWatch.url, revokedWatch.ticket), 401);
  });

  test("revoking a headless key closes its socket and its ticket then gets 401", async () => {
    const name = `stream-keyrevoked-${run}`.slice(0, 40);
    const { key, keyId } = await evalRequest("/eval/seed-headless?space=headless", "POST", { suggestedName: name });
    const headless = headlessClient(key);
    await expectOk(headless.call("register_agent", { name, description: "Stream agent whose key is revoked" }), "register_agent (headless)");
    const keyWatch = await expectOk(headless.call("watch_inbox", { agent: name }), "watch_inbox (headless)");
    const unopenedWatch = await expectOk(headless.call("watch_inbox", { agent: name }), "watch_inbox (headless, unopened)");
    const stream = watchStream(keyWatch.url, keyWatch.ticket);
    await stream.opened;
    const revoked = await evalRequest("/eval/headless-admin?space=headless", "POST", {
      op: "revokeKey",
      input: { keyId },
      who: "keyadmin",
      isAdmin: true,
      verifiedAgoMs: 0,
    });
    assert.ok(revoked.ok, JSON.stringify(revoked));
    assert.equal(await stream.closed, 1008);
    assert.equal(await upgradeStatus(keyWatch.url, keyWatch.ticket), 401);
    assert.equal(await upgradeStatus(unopenedWatch.url, unopenedWatch.ticket), 401);
  });

  test("a headless ticket gets 401 once its sponsor goes stale", async () => {
    const name = `stream-stale-${run}`.slice(0, 40);
    const staleAt = Date.now() + SPONSOR_STALE_MARGIN_MS;
    const { key } = await evalRequest("/eval/seed-headless?space=headless", "POST", {
      suggestedName: name,
      sponsorVerifiedAgoMs: SPONSOR_LIVENESS_MS - SPONSOR_STALE_MARGIN_MS,
    });
    const headless = headlessClient(key);
    await expectOk(headless.call("register_agent", { name, description: "Stream agent whose sponsor goes stale" }), "register_agent (headless)");
    const staleWatch = await expectOk(headless.call("watch_inbox", { agent: name }), "watch_inbox (headless)");
    assert.equal(await upgradeStatus(staleWatch.url, staleWatch.ticket), 101);
    assert.ok(Date.now() < staleAt, "the ticket was checked after the sponsor went stale");
    await delay(staleAt - Date.now() + QUIET_PERIOD_MS);
    assert.equal(await upgradeStatus(staleWatch.url, staleWatch.ticket), 401);
  });

  test("a message that contains a stream ticket is refused", async () => {
    const refused = await senderClient.call("send_message", { ...sender, to: watcherHandle, text: `try ${watch.ticket}` });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /stream ticket/);
  });
});
