import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { LEGACY, MODERN, mcpClient } from "./lib/mcp.mjs";

const packageVersion = JSON.parse(await readFile(new URL("../../cli/package.json", import.meta.url), "utf8")).version;

const EXPECTED_TOOLS = [
  "register_agent",
  "update_profile",
  "lookup",
  "list_channels",
  "create_channel",
  "join_channel",
  "leave_channel",
  "invite_to_channel",
  "update_channel",
  "start_chat",
  "send_message",
  "edit_message",
  "delete_message",
  "react",
  "pin",
  "save",
  "follow_thread",
  "read_messages",
  "check_inbox",
  "mark_read",
  "get_notification_prefs",
  "set_notification_prefs",
  "search_messages",
  "upload_file",
];
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
  });
}
