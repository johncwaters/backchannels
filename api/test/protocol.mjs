import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { after, describe, test } from "node:test";
import { EVAL_URL, LEGACY, MODERN, TEST_SPACE, cleanupHeadlessAgents, evalRequest, headlessClient, mcpClient } from "./lib/mcp.mjs";
import { TOOL_NAMES as EXPECTED_TOOLS } from "./lib/toolNames.mjs";

const packageVersion = JSON.parse(await readFile(new URL("../../cli/package.json", import.meta.url), "utf8")).version;

const MESSAGE_LENGTH = 40_000;
const LOOKUPS_PER_MINUTE = 60;
const DEFAULT_CHANNELS = ["announcements", "introductions", "general", "help", "backchannels-feedback"];
const MAX_TOOL_DEFINITION_BYTES = 6 * 1024;
const MAX_TOOL_LIST_BYTES = 32 * 1024;
const MAX_INSTRUCTIONS_CHARS = 2048;
const FLAT_TYPES = new Set(["string", "number", "integer", "boolean"]);

after(() => cleanupHeadlessAgents());

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

    test("moderator tools/list also stays under the client budget", async () => {
      const space = randomBytes(6).toString("hex");
      const who = "moderatorcheck";
      await evalRequest(`/eval/headless-admin?space=${space}`, "POST", { op: "list", who, isAdmin: true, input: {} });
      const { tools } = await mcpClient(who, protocolVersion, space).request("tools/list");
      assert.ok(tools.some(tool => tool.name === "moderate"));
      const bytes = new TextEncoder().encode(JSON.stringify(tools)).length;
      assert.ok(bytes < MAX_TOOL_LIST_BYTES, `moderator tools/list is ${bytes} bytes`);
      for (const tool of tools) assert.deepEqual(findClosedObjectPaths(tool.outputSchema), []);
    });

    test("create_channel preserves creation while suggesting close existing channels", async () => {
      const client = mcpClient(`similar${run}`.slice(0, 40), protocolVersion, randomBytes(6).toString("hex"));
      const agent = { agent: "similar-channel-reader" };
      await expectOk(client.call("register_agent", { name: agent.agent, description: "Similar channel checks" }), "register_agent (similar)");
      const firstName = `similar-a-${run}`;
      const secondName = `similar-b-${run}`;
      await expectOk(client.call("create_channel", { ...agent, name: firstName, purpose: "CI workflow runners" }), "create_channel (first similar)");
      const created = await expectOk(client.call("create_channel", { ...agent, name: secondName, purpose: "Separate release checks" }), "create_channel (second similar)");
      assert.equal(created.channel, `#${secondName}`);
      assert.equal(created.joined, true);
      assert.ok(created.similar.some(channel => channel.channel === `#${firstName}`));
      assert.ok(created.similar.length <= 3);
      assert.match(created.note, /Created and joined/);
      const listed = await expectOk(client.call("list_channels", { ...agent, query: `similar-`, joined_only: true }), "list_channels (similar)");
      assert.ok(listed.channels.some(channel => channel.channel === `#${secondName}`));
    });

    test("send and edit return emoji text while preserving code through MCP", async () => {
      const client = mcpClient("observer", protocolVersion, randomBytes(6).toString("hex"));
      const agent = { agent: "emoji-author" };
      await expectOk(client.call("register_agent", { name: agent.agent, description: "Emoji storage checks" }), "register (emoji)");
      await expectOk(client.call("create_channel", { ...agent, name: "emoji-io", purpose: "Emoji storage" }), "create (emoji)");
      const sent = await expectOk(client.call("send_message", { ...agent, to: "#emoji-io", text: ":wave: `:wave:` :unknown-code:" }), "send (emoji)");
      const first = await expectOk(client.call("read_messages", { ...agent, conversation: sent.message }), "read (emoji)");
      assert.equal(first.messages[0].text, "👋 `:wave:` :unknown-code:");
      await expectOk(client.call("edit_message", { ...agent, message: sent.message, text: ":rocket:\n~~~\n:wave:\n~~~" }), "edit (emoji)");
      const edited = await expectOk(client.call("read_messages", { ...agent, conversation: sent.message }), "read edit (emoji)");
      assert.equal(edited.messages[0].text, "🚀\n~~~\n:wave:\n~~~");
    });

    test("public read and mark_read clear mentions without joining the channel", async () => {
      const space = randomBytes(6).toString("hex");
      const author = mcpClient("author", protocolVersion, space);
      const observer = mcpClient("observer", protocolVersion, space);
      const writer = { agent: "public-sender" };
      const reader = { agent: "public-reader" };
      await expectOk(author.call("register_agent", { name: writer.agent, description: "Public mention sender" }), "register public sender");
      const profile = await expectOk(observer.call("register_agent", { name: reader.agent, description: "Public mention reader" }), "register public reader");
      await expectOk(author.call("create_channel", { ...writer, name: "outside", purpose: "Public read state" }), "create public channel");
      const first = await expectOk(author.call("send_message", { ...writer, to: "#outside", text: `First ${profile.handle}` }), "send first public mention");
      const reply = await expectOk(author.call("send_message", { ...writer, to: "#outside", text: `Reply ${profile.handle}`, reply_to: first.message }), "send public reply mention");
      const latest = await expectOk(author.call("send_message", { ...writer, to: "#outside", text: `Latest ${profile.handle}` }), "send latest public mention");
      const ids = async () => (await expectOk(observer.call("check_inbox", reader), "check public mentions")).items.map(item => item.message.id);
      assert.deepEqual(await ids(), [first.message, reply.message, latest.message]);
      const page = await expectOk(observer.call("read_messages", { ...reader, conversation: "#outside", after: "0", limit: 1 }), "read first public mention");
      assert.deepEqual(page.messages.map(message => message.id), [first.message]);
      assert.deepEqual(await ids(), [reply.message, latest.message]);
      await expectOk(observer.call("mark_read", { ...reader, conversation: "#outside", up_to: first.message, unread: true }), "restore public mentions");
      assert.deepEqual(await ids(), [first.message, reply.message, latest.message]);
      await expectOk(observer.call("mark_read", { ...reader, conversation: "#outside" }), "mark public channel read");
      assert.deepEqual(await ids(), [reply.message]);
      await expectOk(observer.call("read_messages", { ...reader, conversation: `${first.message}/t` }), "read public thread");
      assert.deepEqual(await ids(), []);
      const listed = await expectOk(observer.call("list_channels", { ...reader, query: "outside" }), "check public membership");
      assert.equal(listed.channels[0].joined, false);
    });

    test("mark_read all clears followed-thread briefs and later replies become unread", async () => {
      const space = randomBytes(6).toString("hex");
      const reader = mcpClient("observer", protocolVersion, space);
      const writer = mcpClient("author", protocolVersion, space);
      const readerAgent = { agent: "all-reader" };
      const writerAgent = { agent: "all-writer" };
      await expectOk(reader.call("register_agent", { name: readerAgent.agent, description: "Read all thread checks" }), "register reader (all)");
      await expectOk(writer.call("register_agent", { name: writerAgent.agent, description: "Write thread replies" }), "register writer (all)");
      await expectOk(reader.call("create_channel", { ...readerAgent, name: "all-threads", purpose: "Read markers" }), "create channel (all)");
      await expectOk(writer.call("join_channel", { ...writerAgent, channel: "#all-threads" }), "join channel (all)");
      const root = await expectOk(reader.call("send_message", { ...readerAgent, to: "#all-threads", text: "Thread root" }), "send root (all)");
      await expectOk(writer.call("send_message", { ...writerAgent, to: "#all-threads", text: "First reply", reply_to: root.message }), "send reply (all)");
      for (const fields of [{ all: true, up_to: root.message }, { messages: [], all: true }, { all: false }]) {
        const invalid = await reader.call("mark_read", { ...readerAgent, ...fields });
        assert.equal(invalid.ok, false);
        assert.match(invalid.error, /require conversation|messages is empty|all must be true/);
      }
      const before = await expectOk(reader.call("check_inbox", readerAgent), "inbox before all");
      assert.equal(before.brief.threads[0].unread_replies, 1);
      await expectOk(reader.call("update_channel", { ...readerAgent, channel: "#all-threads", archived: true }), "archive (all)");
      const marked = await expectOk(reader.call("mark_read", { ...readerAgent, all: true }), "mark all");
      assert.equal(marked.marked_read.threads, 1);
      const after = await expectOk(reader.call("check_inbox", readerAgent), "inbox after all");
      assert.equal(after.items.length, 0);
      assert.equal(after.brief.threads[0].unread_replies, 0);
      await expectOk(reader.call("update_channel", { ...readerAgent, channel: "#all-threads", archived: false }), "restore (all)");
      await expectOk(writer.call("send_message", { ...writerAgent, to: "#all-threads", text: "Later reply", reply_to: root.message }), "send later reply (all)");
      const later = await expectOk(reader.call("check_inbox", readerAgent), "inbox later (all)");
      assert.equal(later.brief.threads[0].unread_replies, 1);
    });

    test("archived-channel refusals point to the last message and current channel", async () => {
      const space = randomBytes(6).toString("hex");
      const client = mcpClient("observer", protocolVersion, space);
      const agent = { agent: "archive-reader" };
      const registered = await expectOk(client.call("register_agent", { name: agent.agent, description: "Archive recovery checks" }), "register (archive)");
      for (const name of ["old-room", "new-room"]) await expectOk(client.call("create_channel", { ...agent, name, purpose: "Archive recovery" }), "create (archive)");
      const last = await expectOk(client.call("send_message", { ...agent, to: "#old-room", text: "This work moved to #new-room." }), "send move notice");
      await expectOk(client.call("update_channel", { ...agent, channel: "#old-room", archived: true }), "archive old room");
      for (const [tool, args] of [
        ["send_message", { to: "#old-room", text: "New post" }],
        ["invite_to_channel", { channel: "#old-room", agents: [registered.handle] }],
        ["update_channel", { channel: "#old-room", topic: "New topic" }],
      ]) {
        const rejected = await client.call(tool, { ...agent, ...args });
        assert.equal(rejected.ok, false);
        assert.ok(rejected.error.includes(last.message));
        assert.match(rejected.error, /this work moved to #new-room; join it/);
      }
      const notice = await expectOk(client.call("read_messages", { ...agent, conversation: last.message }), "read move notice");
      assert.equal(notice.messages[0].text, "This work moved to #new-room.");
      await expectOk(client.call("join_channel", { ...agent, channel: "#new-room" }), "join current room");
      await expectOk(client.call("update_channel", { ...agent, channel: "#old-room", archived: false }), "restore old room");
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
      const mine = await expectOk(owner.call("list_my_agents", {}), "list_my_agents");
      assert.ok(mine.agents.some((listed) => listed.name === "protocol-owner" && listed.handle.endsWith("/protocol-owner")), JSON.stringify(mine));
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
      assert.equal(again.handle, first.handle);
      assert.ok(!again.brief.channels.includes("#general"), "registering again rejoined #general");
    });

    test("leaving a private channel removes its followed threads and pins from the brief", async () => {
      const ownerAgent = { agent: "protocol-owner" };
      const peerAgent = { agent: "protocol-peer" };
      const channel = `private-brief-${run}`.slice(0, 80);
      const peerProfile = await expectOk(peer.call("register_agent", { name: "protocol-peer" }), "register_agent (peer)");
      await expectOk(owner.call("create_channel", { ...ownerAgent, name: channel, private: true, purpose: "Private brief check" }), "create_channel");
      await expectOk(owner.call("invite_to_channel", { ...ownerAgent, channel: `#${channel}`, agents: [peerProfile.handle] }), "invite_to_channel");
      const root = await expectOk(owner.call("send_message", { ...ownerAgent, to: `#${channel}`, text: "Private thread root" }), "send_message (root)");
      await expectOk(peer.call("follow_thread", { ...peerAgent, thread: `${root.message}/t` }), "follow_thread");
      await expectOk(peer.call("pin", { ...peerAgent, message: root.message }), "pin");
      await expectOk(owner.call("send_message", { ...ownerAgent, to: `#${channel}`, text: "Private thread reply", reply_to: root.message }), "send_message (reply)");
      const before = await expectOk(peer.call("register_agent", { name: "protocol-peer" }), "register_agent (before leave)");
      assert.ok(before.brief.threads.some((thread) => thread.thread === `${root.message}/t`));
      assert.ok(before.brief.pins.some((message) => message.id === root.message));
      await expectOk(peer.call("leave_channel", { ...peerAgent, channel: `#${channel}` }), "leave_channel");
      const after = await expectOk(peer.call("register_agent", { name: "protocol-peer" }), "register_agent (after leave)");
      assert.ok(!after.brief.threads.some((thread) => thread.thread === `${root.message}/t`));
      assert.ok(!after.brief.pins.some((message) => message.id === root.message));
      await expectOk(owner.call("invite_to_channel", { ...ownerAgent, channel: `#${channel}`, agents: [peerProfile.handle] }), "invite_to_channel (again)");
      const rejoined = await expectOk(peer.call("register_agent", { name: "protocol-peer" }), "register_agent (rejoined)");
      assert.ok(!rejoined.brief.threads.some((thread) => thread.thread === `${root.message}/t`));
    });

    test("inbox and conversation text previews recover the full message without moving read state", async () => {
      const writer = mcpClient(`previewwriter${run}`.slice(0, 40), protocolVersion);
      const reader = mcpClient(`previewreader${run}`.slice(0, 40), protocolVersion);
      const writerAgent = { agent: "preview-writer" };
      const readerAgent = { agent: "preview-reader" };
      await expectOk(writer.call("register_agent", { name: writerAgent.agent, description: "Preview check writer" }), "register_agent (preview writer)");
      const profile = await expectOk(reader.call("register_agent", { name: readerAgent.agent, description: "Preview check reader" }), "register_agent (preview reader)");
      const channel = `preview-${run}`;
      await expectOk(writer.call("create_channel", { ...writerAgent, name: channel, purpose: "Preview check" }), "create_channel (preview)");
      await expectOk(reader.call("join_channel", { ...readerAgent, channel: `#${channel}` }), "join_channel (preview)");
      const text = `${profile.handle} ${"Long message body. ".repeat(400)}`;
      const fileText = "Attached report text. ".repeat(4000);
      const file = await expectOk(writer.call("upload_file", { ...writerAgent, name: "preview.txt", content: fileText }), "upload_file (preview)");
      const sent = await expectOk(writer.call("send_message", { ...writerAgent, to: `#${channel}`, text, file_ids: [file.file_id] }), "send_message (preview)");
      const inbox = await expectOk(reader.call("check_inbox", readerAgent), "check_inbox (preview)");
      const item = inbox.items.find(item => item.message.id === sent.message);
      assert.equal(item.message.text, text.slice(0, 1000));
      assert.equal(item.message.text_truncated, true);
      assert.equal(item.message.text_length, text.length);
      assert.match(inbox.hint, /read_messages/);
      const full = await expectOk(reader.call("read_messages", { ...readerAgent, conversation: sent.message, detail: "full" }), "read_messages (full body)");
      assert.equal(full.messages[0].text, text);
      assert.equal(full.messages[0].text_truncated, undefined);
      assert.equal(full.messages[0].files[0].text, fileText);
      const unread = await expectOk(reader.call("check_inbox", readerAgent), "check_inbox (still unread)");
      assert.ok(unread.items.some(item => item.message.id === sent.message));
      const page = await expectOk(reader.call("read_messages", { ...readerAgent, conversation: `#${channel}`, detail: "full" }), "read_messages (preview page)");
      assert.equal(page.messages[0].text, text.slice(0, 4000));
      assert.equal(page.messages[0].text_truncated, true);
      assert.equal(page.messages[0].files[0].text, undefined);
      assert.match(page.hint, /read_messages/);
      const search = await expectOk(reader.call("search_messages", { ...readerAgent, query: `in:#${channel}`, detail: "full" }), "search_messages (preview)");
      assert.equal(search.results[0].text, text.slice(0, 4000));
      assert.equal(search.results[0].text_truncated, true);
      assert.equal(search.results[0].files[0].text, undefined);
      assert.match(search.hint, /read_messages/);
    });

    test("message boundaries refuse another conversation without clearing its inbox", async () => {
      const writer = mcpClient(`boundarywriter${run}`.slice(0, 40), protocolVersion);
      const reader = mcpClient(`boundaryreader${run}`.slice(0, 40), protocolVersion);
      const writerAgent = { agent: "boundary-writer" };
      const readerAgent = { agent: "boundary-reader" };
      await expectOk(writer.call("register_agent", { name: writerAgent.agent, description: "Boundary check writer" }), "register_agent (boundary writer)");
      const readerProfile = await expectOk(reader.call("register_agent", { name: readerAgent.agent, description: "Boundary check reader" }), "register_agent (boundary reader)");
      const target = `target-${run}`;
      const source = `source-${run}`;
      for (const channel of [target, source]) {
        await expectOk(writer.call("create_channel", { ...writerAgent, name: channel, purpose: "Message boundary check" }), "create_channel (boundary)");
        await expectOk(reader.call("join_channel", { ...readerAgent, channel: `#${channel}` }), "join_channel (boundary)");
      }
      const targetPost = await expectOk(writer.call("send_message", { ...writerAgent, to: `#${target}`, text: `Boundary check ${readerProfile.handle}` }), "send_message (target)");
      const sourcePost = await expectOk(writer.call("send_message", { ...writerAgent, to: `#${source}`, text: "Source boundary" }), "send_message (source)");
      const before = await expectOk(reader.call("check_inbox", readerAgent), "check_inbox (before boundaries)");
      for (const [tool, args] of [
        ["mark_read", { up_to: sourcePost.message }],
        ["mark_read", { up_to: sourcePost.message, unread: true }],
        ["read_messages", { before: sourcePost.message }],
        ["read_messages", { after: sourcePost.message }],
        ["read_messages", { around: sourcePost.message }],
      ]) {
        const refused = await reader.call(tool, { ...readerAgent, conversation: `#${target}`, ...args });
        assert.equal(refused.ok, false, `${tool} accepted a boundary from another conversation`);
        assert.ok(refused.error.includes(`#${source}`), refused.error);
        assert.ok(refused.error.includes(`#${target}`), refused.error);
        assert.match(refused.error, /pass a message ID from/);
      }
      const after = await expectOk(reader.call("check_inbox", readerAgent), "check_inbox (after boundaries)");
      assert.deepEqual(after.items, before.items);
      assert.deepEqual(after.unread_channels, before.unread_channels);
      const marked = await expectOk(reader.call("mark_read", { ...readerAgent, conversation: `#${target}`, up_to: targetPost.message }), "mark_read (same conversation)");
      assert.equal(marked.read_up_to, targetPost.message);
    });

    test("reply deletion is idempotent and archived channels reject edits, reactions and pins", async () => {
      const ownerAgent = { agent: "protocol-owner" };
      const channel = `mutations-${run}`.slice(0, 80);
      await expectOk(owner.call("create_channel", { ...ownerAgent, name: channel, purpose: "Message mutation check" }), "create_channel");
      const root = await expectOk(owner.call("send_message", { ...ownerAgent, to: `#${channel}`, text: "Mutation root" }), "send_message (root)");
      const reply = await expectOk(owner.call("send_message", { ...ownerAgent, to: `#${channel}`, text: "Mutation reply", reply_to: root.message }), "send_message (reply)");
      const before = await expectOk(owner.call("read_messages", { ...ownerAgent, conversation: root.message }), "read_messages (before delete)");
      assert.equal(before.messages[0].reply_count, 1);
      await expectOk(owner.call("delete_message", { ...ownerAgent, message: reply.message }), "delete_message");
      await expectOk(owner.call("delete_message", { ...ownerAgent, message: reply.message }), "delete_message (again)");
      const after = await expectOk(owner.call("read_messages", { ...ownerAgent, conversation: root.message }), "read_messages (after delete)");
      assert.equal(after.messages[0].reply_count ?? 0, 0);
      await expectOk(owner.call("react", { ...ownerAgent, message: root.message, emoji: "eyes" }), "react");
      await expectOk(owner.call("pin", { ...ownerAgent, message: root.message }), "pin");
      await expectOk(owner.call("update_channel", { ...ownerAgent, channel: `#${channel}`, archived: true }), "update_channel (archive)");
      for (const [tool, argumentsForTool] of [
        ["edit_message", { text: "Edited root" }],
        ["react", { emoji: "rocket" }],
        ["react", { emoji: "eyes", remove: true }],
        ["pin", {}],
        ["pin", { remove: true }],
      ]) {
        const refusal = await owner.call(tool, { ...ownerAgent, message: root.message, ...argumentsForTool });
        assert.equal(refusal.ok, false);
        assert.match(refusal.error, /archived/);
      }
      const archived = await expectOk(owner.call("read_messages", { ...ownerAgent, conversation: root.message, detail: "full" }), "read_messages (archived)");
      assert.equal(archived.messages[0].text, "Mutation root");
      assert.equal(archived.messages[0].pinned, true);
      assert.ok(archived.messages[0].reactions.length > 0);
    });

    test("keyword notifications match phrases and punctuation without substring or deduplication matches", async () => {
      const keywordClient = mcpClient(`keywords${run}`.slice(0, 40), protocolVersion);
      const keywordAgent = { agent: "notification-check" };
      const ownerAgent = { agent: "protocol-owner" };
      const channel = `keywords-${run}`.slice(0, 80);
      await expectOk(keywordClient.call("register_agent", { name: keywordAgent.agent, description: "Keyword notification check" }), "register_agent (keywords)");
      await expectOk(owner.call("create_channel", { ...ownerAgent, name: channel, purpose: "Keyword check" }), "create_channel");
      await expectOk(keywordClient.call("join_channel", { ...keywordAgent, channel: `#${channel}` }), "join_channel");
      await expectOk(keywordClient.call("set_notification_prefs", { ...keywordAgent, keywords: ["api key", "api api", "v1.2"] }), "set_notification_prefs");
      const expectedMessageIds = [];
      for (const [text, shouldNotify] of [["rapi keyboard", false], ["api token key", false], ["api token api", false], ["API\n KEY", true], ["api api key", true], ["Upgrade V1.2", true]]) {
        const sent = await expectOk(owner.call("send_message", { ...ownerAgent, to: `#${channel}`, text }), "send_message (keyword)");
        if (shouldNotify) expectedMessageIds.push(sent.message);
      }
      const inbox = await expectOk(keywordClient.call("check_inbox", keywordAgent), "check_inbox (keywords)");
      assert.deepEqual(inbox.items.filter((item) => item.reason === "keyword").map((item) => item.message.id), expectedMessageIds);
    });

    test("search cursors return successive pages from the same final order", async () => {
      const ownerAgent = { agent: "protocol-owner" };
      const channel = `search-pages-${run}`.slice(0, 80);
      await expectOk(owner.call("create_channel", { ...ownerAgent, name: channel, purpose: "Search page check" }), "create_channel");
      const sentMessageIds = [];
      for (let index = 0; index < 3; index++) {
        const sent = await expectOk(owner.call("send_message", { ...ownerAgent, to: `#${channel}`, text: `Search page ${index}` }), "send_message (search page)");
        sentMessageIds.push(sent.message);
      }
      const first = await expectOk(owner.call("search_messages", { ...ownerAgent, query: `in:#${channel}`, limit: 1 }), "search_messages (first page)");
      assert.ok(first.next_cursor);
      await expectOk(owner.call("send_message", { ...ownerAgent, to: `#${channel}`, text: "Later message" }), "send_message (after search)");
      const second = await expectOk(owner.call("search_messages", { ...ownerAgent, cursor: first.next_cursor, limit: 1 }), "search_messages (second page)");
      const third = await expectOk(owner.call("search_messages", { ...ownerAgent, cursor: second.next_cursor, limit: 1 }), "search_messages (third page)");
      const returnedMessageIds = [...first.results, ...second.results, ...third.results].map((message) => message.id);
      assert.equal(returnedMessageIds.length, 3);
      assert.deepEqual(new Set(returnedMessageIds), new Set(sentMessageIds));
      assert.equal(third.next_cursor, null);
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

function watchStream(url, ticket, resumeProtocols = []) {
  const socket = new WebSocket(url, ["bc-stream", ticket, ...resumeProtocols]);
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
    assert.equal(watch.url, `${EVAL_URL}/stream/ws_e${TEST_SPACE}`);
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
    assert.deepEqual(Object.keys(event).sort(), ["conversation", "cursor", "from", "message", "reason"]);
    assert.ok(Number.isSafeInteger(event.cursor) && event.cursor > 0);
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

describe("resumable inbox push stream", () => {
  async function createStreamFixture(context) {
    const space = randomBytes(6).toString("hex");
    const watcherClient = mcpClient("watcher", MODERN, space);
    const senderClient = mcpClient("sender", MODERN, space);
    const watcher = { agent: "stream-listener" };
    const sender = { agent: "stream-publisher" };
    const registered = await expectOk(watcherClient.call("register_agent", { name: watcher.agent, description: "Receives resumable inbox pushes" }), "register watcher");
    await expectOk(senderClient.call("register_agent", { name: sender.agent, description: "Sends resumable inbox fixtures" }), "register sender");
    const watch = await expectOk(watcherClient.call("watch_inbox", watcher), "watch inbox");
    const streams = [];
    context.after(async () => {
      await Promise.all(streams.map(stream => stream.close()));
    });
    async function open(resumeProtocols = []) {
      const stream = watchStream(watch.url, watch.ticket, resumeProtocols);
      streams.push(stream);
      await stream.opened;
      assert.equal(stream.socket.protocol, "bc-stream");
      return stream;
    }
    const send = text => expectOk(senderClient.call("send_message", { ...sender, to: registered.handle, text }), "send message");
    const markRead = messages => expectOk(watcherClient.call("mark_read", { ...watcher, messages }), "mark read");
    return { open, send, markRead };
  }

  test("only sockets offering resume receive a cursor and legacy pushes stay unchanged", async context => {
    const { open, send } = await createStreamFixture(context);
    const legacy = await open();
    const invalid = await open(["bc-resume.-1", "bc-resume.1000000000000000"]);
    const capable = await open(["bc-resume"]);
    assert.deepEqual(await capable.nextEvent(), { type: "cursor", cursor: 0 });
    await delay(QUIET_PERIOD_MS);
    assert.deepEqual(legacy.events, []);
    assert.deepEqual(invalid.events, []);
    assert.deepEqual(capable.events, []);
    const sent = await send("resume capability");
    const pushed = await capable.nextEvent();
    assert.equal(pushed.message, sent.message);
    assert.ok(Number.isSafeInteger(pushed.cursor) && pushed.cursor > 0);
    assert.deepEqual(await legacy.nextEvent(), pushed);
    assert.deepEqual(await invalid.nextEvent(), pushed);
  });

  test("a stale resume cursor replays only unread items on its own socket despite the server cursor", async context => {
    const { open, send, markRead } = await createStreamFixture(context);
    const original = await open(["bc-resume"]);
    assert.deepEqual(await original.nextEvent(), { type: "cursor", cursor: 0 });
    const first = await send("first unread push");
    const firstPush = await original.nextEvent();
    const second = await send("second unread push");
    const secondPush = await original.nextEvent();
    assert.ok(secondPush.cursor > firstPush.cursor);
    await original.close();
    const legacy = await open();
    const resumed = await open(["bc-resume.0"]);
    assert.deepEqual(await resumed.nextEvent(), { type: "cursor", cursor: secondPush.cursor });
    assert.deepEqual(await resumed.nextEvent(), firstPush);
    await delay(QUIET_PERIOD_MS);
    assert.deepEqual(resumed.events, []);
    assert.deepEqual(legacy.events, []);
    await resumed.close();
    const current = await open(["bc-resume", `bc-resume.${secondPush.cursor}`]);
    assert.deepEqual(await current.nextEvent(), { type: "cursor", cursor: secondPush.cursor });
    await delay(QUIET_PERIOD_MS);
    assert.deepEqual(current.events, []);
    await current.close();
    await markRead([first.message]);
    const afterReadingFirst = await open(["bc-resume.0"]);
    assert.deepEqual(await afterReadingFirst.nextEvent(), { type: "cursor", cursor: secondPush.cursor });
    assert.deepEqual(await afterReadingFirst.nextEvent(), secondPush);
    await afterReadingFirst.close();
    await markRead([second.message]);
    const afterReadingBoth = await open(["bc-resume.0"]);
    assert.deepEqual(await afterReadingBoth.nextEvent(), { type: "cursor", cursor: secondPush.cursor });
    await delay(QUIET_PERIOD_MS);
    assert.deepEqual(afterReadingBoth.events, []);
    assert.deepEqual(legacy.events, []);
  });

  test("cursor precedes a pending push and resuming uses the supplied cursor after a batch advances the server cursor", async context => {
    const { open, send } = await createStreamFixture(context);
    const first = await send("first disconnected message");
    const second = await send("second disconnected message");
    const initial = await open(["bc-resume"]);
    assert.deepEqual(await initial.nextEvent(), { type: "cursor", cursor: 0 });
    const firstPush = await initial.nextEvent();
    assert.equal(firstPush.message, first.message);
    await initial.close();
    const resumed = await open([`bc-resume.${firstPush.cursor}`]);
    const serverCursor = await resumed.nextEvent();
    const secondPush = await resumed.nextEvent();
    assert.deepEqual(serverCursor, { type: "cursor", cursor: secondPush.cursor });
    assert.ok(secondPush.cursor > firstPush.cursor);
    assert.equal(secondPush.message, second.message);
    await delay(QUIET_PERIOD_MS);
    assert.deepEqual(resumed.events, []);
  });
});

describe("one open session per agent name", () => {
  const run = Date.now().toString(36);
  const holderClient = mcpClient(`holder${run}`.slice(0, 40));
  const IDLE_PAST_HOLD_MS = 16 * 60 * 1000;
  const newSession = () => crypto.randomUUID();

  function registerAs(name, session, process) {
    const args = { name, description: "Session hold check", ...(session ? { session } : {}), ...(process ? { process } : {}) };
    return holderClient.call("register_agent", args);
  }

  async function expectRefused(name, session, process) {
    const refused = await registerAs(name, session, process);
    assert.equal(refused.ok, false, `a second session registered ${name}`);
    assert.match(refused.error, new RegExp(`is in use by another open session; register as ${name}-2 instead`));
  }

  const lapseHold = (handle) => evalRequest("/eval/backdate-activity", "POST", { handle, idleMs: IDLE_PAST_HOLD_MS });

  async function lastActive(name) {
    const { agents } = await expectOk(holderClient.call("list_my_agents", {}), "list_my_agents");
    return agents.find((listed) => listed.name === name).last_active;
  }

  test("a second session is refused with a numbered name while the first is active", async () => {
    await expectOk(registerAs("hold-active", newSession()), "register_agent (first session)");
    await expectRefused("hold-active", newSession());
  });

  test("the same session re-registers", async () => {
    const session = newSession();
    await expectOk(registerAs("hold-same", session), "register_agent");
    await expectOk(registerAs("hold-same", session), "register_agent (again)");
  });

  test("a register without a session skips the check and keeps the holder", async () => {
    const holder = newSession();
    await expectOk(registerAs("hold-sessionless", holder), "register_agent (holder)");
    await expectOk(registerAs("hold-sessionless"), "register_agent (no session)");
    await expectRefused("hold-sessionless", newSession());
    await expectOk(registerAs("hold-sessionless", holder), "register_agent (holder again)");
  });

  test("an idle session with an open socket keeps the name, and the refusal does not refresh it", async () => {
    const holder = newSession();
    const { handle } = await expectOk(registerAs("hold-socket", holder), "register_agent (holder)");
    const watch = await expectOk(holderClient.call("watch_inbox", { agent: "hold-socket", session: holder }), "watch_inbox");
    const stream = watchStream(watch.url, watch.ticket);
    await stream.opened;
    await lapseHold(handle);
    const idleSince = await lastActive("hold-socket");
    await expectRefused("hold-socket", newSession());
    assert.equal(await lastActive("hold-socket"), idleSince);
    await stream.close();
  });

  test("watch_inbox from a session that does not hold the name is refused and mints no ticket", async () => {
    const holder = newSession();
    await expectOk(registerAs("hold-ticket", holder), "register_agent (holder)");
    const outsider = await holderClient.call("watch_inbox", { agent: "hold-ticket", session: newSession() });
    assert.equal(outsider.ok, false, "watch_inbox minted a ticket for a session that does not hold the name");
    assert.match(outsider.error, /is in use by another open session; register as hold-ticket-2 instead/);
    const own = await expectOk(holderClient.call("watch_inbox", { agent: "hold-ticket", session: holder }), "watch_inbox (holder)");
    assert.equal(await upgradeStatus(own.url, own.ticket), 101);
  });

  test("watch_inbox with a session for a name registered without one mints a working ticket", async () => {
    await expectOk(registerAs("hold-unbound"), "register_agent (no session)");
    const watch = await expectOk(holderClient.call("watch_inbox", { agent: "hold-unbound", session: newSession() }), "watch_inbox (session)");
    assert.equal(await upgradeStatus(watch.url, watch.ticket), 101);
  });

  test("the same process with a new session takes the name and ends the old session's stream", async () => {
    const process = newSession().replaceAll("-", "");
    const oldSession = newSession();
    await expectOk(registerAs("hold-cleared", oldSession, process), "register_agent (before clear)");
    const oldWatch = await expectOk(holderClient.call("watch_inbox", { agent: "hold-cleared", session: oldSession }), "watch_inbox (before clear)");
    const oldStream = watchStream(oldWatch.url, oldWatch.ticket);
    await oldStream.opened;
    const newSessionAfterClear = newSession();
    await expectOk(registerAs("hold-cleared", newSessionAfterClear, process), "register_agent (after clear)");
    assert.equal(await oldStream.closed, 1008);
    const newWatch = await expectOk(holderClient.call("watch_inbox", { agent: "hold-cleared", session: newSessionAfterClear }), "watch_inbox (after clear)");
    assert.equal(await upgradeStatus(newWatch.url, newWatch.ticket), 101);
  });

  test("a different process with a different session is refused", async () => {
    await expectOk(registerAs("hold-process", newSession(), newSession().replaceAll("-", "")), "register_agent (holder)");
    await expectRefused("hold-process", newSession(), newSession().replaceAll("-", ""));
  });

  test("the same session in a different process re-registers", async () => {
    const session = newSession();
    await expectOk(registerAs("hold-resumed", session, newSession().replaceAll("-", "")), "register_agent (first process)");
    await expectOk(registerAs("hold-resumed", session, newSession().replaceAll("-", "")), "register_agent (resumed process)");
  });

  test("a new session takes over a lapsed name and the old session's ticket then gets 401", async () => {
    const oldSession = newSession();
    const { handle } = await expectOk(registerAs("hold-lapsed", oldSession), "register_agent (old session)");
    const oldWatch = await expectOk(holderClient.call("watch_inbox", { agent: "hold-lapsed", session: oldSession }), "watch_inbox (old session)");
    await lapseHold(handle);
    await expectOk(registerAs("hold-lapsed", newSession()), "register_agent (takeover)");
    assert.equal(await upgradeStatus(oldWatch.url, oldWatch.ticket), 401);
    await expectRefused("hold-lapsed", oldSession);
  });

  test("a takeover deletes the old session's tickets", async () => {
    const { handle } = await expectOk(registerAs("hold-tickets", newSession()), "register_agent (old session)");
    const sessionlessWatch = await expectOk(holderClient.call("watch_inbox", { agent: "hold-tickets" }), "watch_inbox (no session)");
    await lapseHold(handle);
    await expectOk(registerAs("hold-tickets", newSession()), "register_agent (takeover)");
    assert.equal(await upgradeStatus(sessionlessWatch.url, sessionlessWatch.ticket), 401);
  });

  test("a first session claims a name registered without one and keeps its tickets", async () => {
    await expectOk(registerAs("hold-unclaimed"), "register_agent (no session)");
    const sessionlessWatch = await expectOk(holderClient.call("watch_inbox", { agent: "hold-unclaimed" }), "watch_inbox (no session)");
    await expectOk(registerAs("hold-unclaimed", newSession()), "register_agent (claim)");
    await expectRefused("hold-unclaimed", newSession());
    assert.equal(await upgradeStatus(sessionlessWatch.url, sessionlessWatch.ticket), 101);
  });
});

test("search follow-up actions and inbox read transitions remain idempotent", async () => {
  const space = `speed${randomBytes(4).toString("hex")}`;
  const author = mcpClient("author", MODERN, space);
  const reader = mcpClient("reader", MODERN, space);
  const authorAgent = { agent: "speed-sender" };
  const readerAgent = { agent: "speed-watcher" };
  await expectOk(author.call("register_agent", { name: "speed-sender", description: "Hot path protocol author" }), "register author");
  await expectOk(reader.call("register_agent", { name: "speed-watcher", description: "Hot path protocol reader" }), "register reader");
  await expectOk(author.call("create_channel", { ...authorAgent, name: "speed", purpose: "Hot path protocol checks" }), "create channel");
  await expectOk(reader.call("join_channel", { ...readerAgent, channel: "#speed" }), "join channel");
  await expectOk(reader.call("set_notification_prefs", { ...readerAgent, level: "all" }), "set default preferences");
  const sent = await expectOk(author.call("send_message", { ...authorAgent, to: "#speed", text: "A searchable message" }), "send message");
  const searched = await expectOk(reader.call("search_messages", { ...readerAgent, query: "in:#speed", sort: "recent" }), "search message");
  assert.ok(searched.results.some((message) => message.id === sent.message));
  for (let attempt = 0; attempt < 2; attempt++) {
    await expectOk(reader.call("read_messages", { ...readerAgent, conversation: "#speed" }), "read search result");
    await expectOk(reader.call("save", { ...readerAgent, message: sent.message }), "save search result");
  }
  const readInbox = await expectOk(reader.call("check_inbox", readerAgent), "check cleared inbox");
  assert.equal(readInbox.items.length, 0);
  for (let attempt = 0; attempt < 2; attempt++) {
    await expectOk(reader.call("mark_read", { ...readerAgent, conversation: "#speed", up_to: sent.message, unread: true }), "mark unread");
  }
  const unreadInbox = await expectOk(reader.call("check_inbox", readerAgent), "check restored inbox");
  assert.deepEqual(unreadInbox.items.map((item) => ({ id: item.message.id, reason: item.reason })), [{ id: sent.message, reason: "channel" }]);
  await expectOk(reader.call("mark_read", { ...readerAgent, conversation: "#speed" }), "mark channel read");
  const clearedInbox = await expectOk(reader.call("check_inbox", readerAgent), "check marked inbox");
  assert.equal(clearedInbox.items.length, 0);
});
