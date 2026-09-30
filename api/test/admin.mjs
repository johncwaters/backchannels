import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { evalRequest, mcpClient } from "./lib/mcp.mjs";

const SPACE = "adminread";

function adminRead(who, input) {
  return evalRequest(`/eval/admin-read?space=${SPACE}`, "POST", { who, input });
}

async function expectOutput(pending) {
  const response = await pending;
  assert.ok(response.ok, response.error);
  return response.output;
}

describe("admin thread reading", () => {
  const run = Date.now().toString(36);
  const channel = `threads-${run}`;
  const agent = { agent: `threader-${run}` };
  const owner = mcpClient("threadowner", undefined, SPACE);
  let rootSeq;
  let rootMessage;
  let firstReply;

  test("a thread reads as its root then its replies, oldest first", async () => {
    await expectOutput(owner.call("register_agent", { name: agent.agent, description: "Admin thread check" }));
    await expectOutput(owner.call("create_channel", { ...agent, name: channel, purpose: "admin thread check" }));
    const root = await expectOutput(owner.call("send_message", { ...agent, to: `#${channel}`, text: "root message" }));
    firstReply = (await expectOutput(owner.call("send_message", { ...agent, to: `#${channel}`, text: "first reply", reply_to: root.message }))).message;
    await expectOutput(owner.call("send_message", { ...agent, to: `#${channel}`, text: "second reply", reply_to: root.message }));
    await expectOutput(owner.call("send_message", { ...agent, to: `#${channel}`, text: "later top-level message" }));
    rootMessage = root.message;
    rootSeq = Number(root.message.split("/").at(-1));

    const channelView = await adminRead("threadowner", { conversation: channel });
    assert.ok(channelView.ok, JSON.stringify(channelView));
    assert.deepEqual(channelView.value.messages.map((message) => message.text), ["root message", "later top-level message"]);
    assert.equal(channelView.value.messages[0].threadReplies, 2);

    const threadView = await adminRead("threadowner", { conversation: channel, thread: rootSeq });
    assert.ok(threadView.ok, JSON.stringify(threadView));
    assert.deepEqual(threadView.value.messages.map((message) => message.text), ["root message", "first reply", "second reply"]);
  });

  test("reactions list each emoji once with every agent who used it, in first-use order", async () => {
    const peer = mcpClient("threadpeer", undefined, SPACE);
    const peerAgent = { agent: `peer-${run}` };
    await expectOutput(peer.call("register_agent", { name: peerAgent.agent, description: "Admin reaction check" }));
    await expectOutput(peer.call("join_channel", { ...peerAgent, channel: `#${channel}` }));
    await expectOutput(owner.call("react", { ...agent, message: rootMessage, emoji: "rocket" }));
    await expectOutput(peer.call("react", { ...peerAgent, message: rootMessage, emoji: "+1" }));
    await expectOutput(peer.call("react", { ...peerAgent, message: rootMessage, emoji: "rocket" }));

    const channelView = await adminRead("threadowner", { conversation: channel });
    const [ownerHandle, peerHandle] = channelView.value.messages[0].reactions[0].agents;
    assert.deepEqual(
      channelView.value.messages.map((message) => message.reactions.map((reaction) => [reaction.emoji, reaction.agents.length])),
      [[["rocket", 2], ["+1", 1]], []],
    );
    assert.match(ownerHandle, new RegExp(`/threader-${run}$`));
    assert.match(peerHandle, new RegExp(`/peer-${run}$`));
  });

  test("a deleted reply leaves the reply count and the thread", async () => {
    await expectOutput(owner.call("delete_message", { ...agent, message: firstReply }));
    const channelView = await adminRead("threadowner", { conversation: channel });
    assert.equal(channelView.value.messages[0].threadReplies, 1);
    const threadView = await adminRead("threadowner", { conversation: channel, thread: rootSeq });
    assert.deepEqual(threadView.value.messages.map((message) => message.text), ["root message", "second reply"]);
  });

  test("a reply or unknown seq is not a thread", async () => {
    assert.deepEqual(await adminRead("threadowner", { conversation: channel, thread: rootSeq + 1 }), { ok: false, error: "not_found" });
    assert.deepEqual(await adminRead("threadowner", { conversation: channel, thread: 999999 }), { ok: false, error: "not_found" });
    assert.deepEqual(await adminRead("threadowner", { conversation: channel, thread: 0 }), { ok: false, error: "invalid" });
  });
});
