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
    assert.match(channelView.value.messages[0].lastReplyAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(channelView.value.messages[1].lastReplyAt, null);

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

function adminSearch(who, input) {
  return evalRequest(`/eval/admin-search?space=${SPACE}`, "POST", { who, input });
}

describe("admin search", () => {
  const run = Date.now().toString(36);
  const word = `zyx${run}`;
  const ownChannel = `search-own-${run}`;
  const otherChannel = `search-other-${run}`;
  const owner = mcpClient("searchowner", undefined, SPACE);
  const stranger = mcpClient("searchstranger", undefined, SPACE);
  const ownAgent = { agent: `finder-${run}` };
  const strangerAgent = { agent: `other-${run}` };

  test("setup", async () => {
    await expectOutput(owner.call("register_agent", { name: ownAgent.agent, description: "Admin search check" }));
    await expectOutput(stranger.call("register_agent", { name: strangerAgent.agent, description: "Admin search check" }));
    await expectOutput(owner.call("create_channel", { ...ownAgent, name: ownChannel, purpose: "admin search check" }));
    await expectOutput(stranger.call("create_channel", { ...strangerAgent, name: otherChannel, purpose: "admin search check" }));
    await expectOutput(owner.call("send_message", { ...ownAgent, to: `#${ownChannel}`, text: `first ${word} note` }));
    await expectOutput(owner.call("send_message", { ...ownAgent, to: `#${ownChannel}`, text: `second ${word} note` }));
    await expectOutput(stranger.call("send_message", { ...strangerAgent, to: `#${otherChannel}`, text: `stranger ${word} note` }));
  });

  test("mine finds only conversations the viewer's agents are in; everyone adds every public channel", async () => {
    const mine = await adminSearch("searchowner", { query: word, scope: "mine" });
    assert.ok(mine.ok, JSON.stringify(mine));
    const mineIds = new Set(mine.value.matches.map((match) => match.conversation.id));
    assert.ok(mineIds.has(ownChannel) && !mineIds.has(otherChannel), JSON.stringify([...mineIds]));
    const everyone = await adminSearch("searchowner", { query: word, scope: "everyone" });
    const everyoneIds = new Set(everyone.value.matches.map((match) => match.conversation.id));
    assert.ok(everyoneIds.has(ownChannel) && everyoneIds.has(otherChannel), JSON.stringify([...everyoneIds]));
    const exactMatches = everyone.value.matches.filter((match) => match.message.text.includes(word));
    assert.equal(exactMatches.length, 3);
    assert.ok(exactMatches.every((match) => match.ranges.length > 0));
  });

  test("modifiers resolve against the viewer's own agents", async () => {
    const fromMe = await adminSearch("searchowner", { query: `${word} from:me`, scope: "everyone" });
    assert.ok(fromMe.value.matches.length >= 2 && fromMe.value.matches.every((match) => match.message.isOwn));
    const recent = await adminSearch("searchowner", { query: `in:#${ownChannel}`, scope: "everyone", sort: "recent" });
    assert.deepEqual(recent.value.matches.map((match) => match.message.text), [`second ${word} note`, `first ${word} note`]);
  });

  test("an unknown channel explains itself instead of failing", async () => {
    const unknown = await adminSearch("searchowner", { query: `in:#nowhere-${run}`, scope: "everyone" });
    assert.ok(unknown.ok, JSON.stringify(unknown));
    assert.deepEqual(unknown.value.matches, []);
    assert.match(unknown.value.problem, /not found/);
  });
});

function adminPins(who, input) {
  return evalRequest(`/eval/admin-pins?space=${SPACE}`, "POST", { who, input });
}

describe("admin reading positions and message state", () => {
  const run = Date.now().toString(36);
  const channel = `positions-${run}`;
  const agent = { agent: `positioner-${run}` };
  const owner = mcpClient("positionowner", undefined, SPACE);
  const refs = [];

  test("setup", async () => {
    await expectOutput(owner.call("register_agent", { name: agent.agent, description: "Admin position check" }));
    await expectOutput(owner.call("create_channel", { ...agent, name: channel, purpose: "admin position check" }));
    for (let index = 1; index <= 7; index++) {
      refs.push((await expectOutput(owner.call("send_message", { ...agent, to: `#${channel}`, text: `message ${index}` }))).message);
    }
  });

  const seqOf = (ref) => Number(ref.split("/").at(-1));
  const texts = (page) => page.value.messages.map((message) => message.text);

  test("around centers the page on a message and reports both directions", async () => {
    const page = await adminRead("positionowner", { conversation: channel, around: seqOf(refs[3]), limit: 3 });
    assert.deepEqual(texts(page), ["message 3", "message 4", "message 5"]);
    assert.equal(page.value.nextBefore, seqOf(refs[2]));
    assert.equal(page.value.nextAfter, seqOf(refs[4]));
  });

  test("after reads newer messages oldest first; before reports newer ones", async () => {
    const after = await adminRead("positionowner", { conversation: channel, after: seqOf(refs[4]), limit: 5 });
    assert.deepEqual(texts(after), ["message 6", "message 7"]);
    assert.equal(after.value.nextAfter, undefined);
    const before = await adminRead("positionowner", { conversation: channel, before: seqOf(refs[2]), limit: 5 });
    assert.deepEqual(texts(before), ["message 1", "message 2"]);
    assert.equal(before.value.nextAfter, seqOf(refs[1]));
    const latest = await adminRead("positionowner", { conversation: channel, limit: 2 });
    assert.equal(latest.value.nextAfter, undefined);
    assert.deepEqual(await adminRead("positionowner", { conversation: channel, before: 3, after: 1 }), { ok: false, error: "invalid" });
  });

  test("messages carry pins, edits, deletions and files; pins list newest pin first", async () => {
    await expectOutput(owner.call("pin", { ...agent, message: refs[0] }));
    await expectOutput(owner.call("pin", { ...agent, message: refs[5] }));
    await expectOutput(owner.call("edit_message", { ...agent, message: refs[1], text: "message 2, edited" }));
    const upload = await expectOutput(owner.call("upload_file", { ...agent, name: "notes.txt", content: "file body" }));
    const withFile = await expectOutput(owner.call("send_message", { ...agent, to: `#${channel}`, text: "", file_ids: [upload.file_id] }));
    const page = await adminRead("positionowner", { conversation: channel, limit: 10 });
    const bySeq = new Map(page.value.messages.map((message) => [message.seq, message]));
    assert.match(bySeq.get(seqOf(refs[0])).pinned.by, new RegExp(`/positioner-${run}$`));
    assert.equal(bySeq.get(seqOf(refs[2])).pinned, null);
    assert.ok(bySeq.get(seqOf(refs[1])).editedAt);
    assert.deepEqual(bySeq.get(seqOf(withFile.message)).files.map((file) => [file.name, file.size]), [["notes.txt", 9]]);
    assert.equal(page.value.conversation.pins, 2);
    const pins = await adminPins("positionowner", { conversation: channel });
    assert.deepEqual(texts(pins), ["message 6", "message 1"]);
  });
});
