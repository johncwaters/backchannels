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

function adminMarkRead(who, input) {
  return evalRequest(`/eval/admin-mark-read?space=${SPACE}`, "POST", { who, input });
}

describe("admin read state per person", () => {
  const run = Date.now().toString(36);
  const channel = `unread-${run}`;
  const readerName = `unreadreader${run}`;
  const posterName = `unreadposter${run}`;
  const reader = mcpClient(readerName, undefined, SPACE);
  const poster = mcpClient(posterName, undefined, SPACE);
  const readerAgent = { agent: `reader-${run}` };
  const posterAgent = { agent: `poster-${run}` };
  const seqOf = (ref) => Number(ref.split("/").at(-1));
  let rootRef;

  test("messages from before the first visit count as read", async () => {
    await expectOutput(reader.call("register_agent", { name: readerAgent.agent, description: "Admin unread check" }));
    await expectOutput(poster.call("register_agent", { name: posterAgent.agent, description: "Admin unread check" }));
    await expectOutput(reader.call("create_channel", { ...readerAgent, name: channel, purpose: "admin unread check" }));
    await expectOutput(poster.call("join_channel", { ...posterAgent, channel: `#${channel}` }));
    rootRef = (await expectOutput(poster.call("send_message", { ...posterAgent, to: `#${channel}`, text: "before the first visit" }))).message;
    const firstVisit = await adminRead(readerName, { conversation: channel });
    assert.equal(firstVisit.value.conversation.unread, 0);
    assert.equal(firstVisit.value.firstUnreadSeq, undefined);
  });

  test("new messages from other people are unread; the viewer's own agents' are not", async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const fromPoster = (await expectOutput(poster.call("send_message", { ...posterAgent, to: `#${channel}`, text: "after the first visit" }))).message;
    await expectOutput(reader.call("send_message", { ...readerAgent, to: `#${channel}`, text: "my own agent" }));
    await expectOutput(poster.call("send_message", { ...posterAgent, to: `#${channel}`, text: "a reply", reply_to: rootRef }));
    const page = await adminRead(readerName, { conversation: channel });
    assert.equal(page.value.conversation.unread, 1);
    assert.equal(page.value.firstUnreadSeq, seqOf(fromPoster));
    const root = page.value.messages.find((message) => message.seq === seqOf(rootRef));
    assert.equal(root.unreadReplies, 1);

    const marked = await adminMarkRead(readerName, { conversation: channel, upToSeq: seqOf(fromPoster) });
    assert.deepEqual(marked, { ok: true, value: { unread: 0 } });
    const backwards = await adminMarkRead(readerName, { conversation: channel, upToSeq: 1 });
    assert.deepEqual(backwards, { ok: true, value: { unread: 0 } });
    const afterReading = await adminRead(readerName, { conversation: channel });
    assert.equal(afterReading.value.firstUnreadSeq, undefined);
    assert.ok(afterReading.value.lastReadSeq >= seqOf(fromPoster));
  });

  test("threads keep their own read position", async () => {
    const thread = await adminRead(readerName, { conversation: channel, thread: seqOf(rootRef) });
    assert.ok(thread.value.firstUnreadSeq > seqOf(rootRef));
    await adminMarkRead(readerName, { conversation: channel, thread: seqOf(rootRef), upToSeq: thread.value.firstUnreadSeq });
    const channelView = await adminRead(readerName, { conversation: channel });
    assert.equal(channelView.value.messages.find((message) => message.seq === seqOf(rootRef)).unreadReplies, 0);
    const otherPerson = await adminRead(posterName, { conversation: channel });
    assert.equal(otherPerson.value.conversation.unread, 0);
  });
});

function ownAgents(op, who, input = {}, space = SPACE) {
  return evalRequest(`/eval/own-agents?space=${space}`, "POST", { op, who, input });
}

const bareHandle = (handle) => handle.replace(/^@/, "");

async function listedHandles(who, space = SPACE) {
  const listed = await ownAgents("list", who, {}, space);
  assert.ok(listed.ok, JSON.stringify(listed));
  return listed.value.agents.map((agent) => agent.handle);
}

describe("revoking your own agents", () => {
  const run = Date.now().toString(36);
  const ownerWho = `revokeowner${run}`;
  const strangerWho = `revokestranger${run}`;
  const owner = mcpClient(ownerWho, undefined, SPACE);
  const stranger = mcpClient(strangerWho, undefined, SPACE);
  let ownHandle;
  let strangerHandle;

  test("setup", async () => {
    ownHandle = bareHandle((await expectOutput(owner.call("register_agent", { name: `own-${run}`, description: "Own revoke check" }))).handle);
    strangerHandle = bareHandle(
      (await expectOutput(stranger.call("register_agent", { name: `theirs-${run}`, description: "Own revoke check" }))).handle,
    );
    assert.ok((await listedHandles(ownerWho)).includes(ownHandle));
    assert.ok(!(await listedHandles(ownerWho)).includes(strangerHandle));
  });

  test("another carbon unit's agent is not found and stays live", async () => {
    assert.deepEqual(await ownAgents("revoke", ownerWho, { handle: `@${strangerHandle}` }), { ok: false, error: "not_found" });
    assert.ok((await listedHandles(strangerWho)).includes(strangerHandle));
  });

  test("the same carbon unit name in another workspace cannot revoke the agent", async () => {
    assert.deepEqual(await ownAgents("revoke", ownerWho, { handle: ownHandle }, "revokeoutside"), { ok: false, error: "not_found" });
    assert.ok((await listedHandles(ownerWho)).includes(ownHandle));
  });

  test("a missing handle is invalid", async () => {
    assert.deepEqual(await ownAgents("revoke", ownerWho, {}), { ok: false, error: "invalid" });
  });

  test("an own agent is revoked, leaves the list, stops working, and its handle cannot be registered again", async () => {
    assert.deepEqual(await ownAgents("revoke", ownerWho, { handle: `@${ownHandle}` }), { ok: true, value: null });
    assert.ok(!(await listedHandles(ownerWho)).includes(ownHandle));
    const reregistered = await owner.call("register_agent", { name: `own-${run}`, description: "again" });
    assert.equal(reregistered.ok, false);
    assert.match(reregistered.error, /revoked/);
    assert.equal((await owner.call("check_inbox", { agent: `own-${run}` })).ok, false);
  });

  test("revoking an own agent frees a live agent slot", async () => {
    const cappedWho = `capowner${run}`;
    const capped = mcpClient(cappedWho, undefined, SPACE);
    const liveAgentsPerCarbonUnit = 50;
    await evalRequest(`/eval/seed-live-agents?space=${SPACE}`, "POST", { who: cappedWho, count: liveAgentsPerCarbonUnit - 1 });
    const last = await expectOutput(capped.call("register_agent", { name: `last-${run}`, description: "Fills the cap" }));
    const refused = await capped.call("register_agent", { name: `over-${run}`, description: "Over the cap" });
    assert.equal(refused.ok, false);
    assert.match(refused.error, new RegExp(`${liveAgentsPerCarbonUnit} live agents`));
    assert.deepEqual(await ownAgents("revoke", cappedWho, { handle: last.handle }), { ok: true, value: null });
    await expectOutput(capped.call("register_agent", { name: `over-${run}`, description: "Fits after revoking" }));
  });
});

describe("search precision", () => {
  const run = Date.now().toString(36);
  const channel = `precision-${run}`;
  const alpha = `alpha${run}`;
  const beta = `beta${run}`;
  const gamma = `gamma${run}`;
  const searcher = mcpClient("precisionowner", undefined, SPACE);
  const agent = { agent: `precise-${run}` };
  const textsOf = (list) => (list ?? []).map((result) => result.text ?? result.snippet);

  test("setup", async () => {
    await expectOutput(searcher.call("register_agent", { name: agent.agent, description: "Search precision check" }));
    await expectOutput(searcher.call("create_channel", { ...agent, name: channel, purpose: "search precision check" }));
    await expectOutput(searcher.call("send_message", { ...agent, to: `#${channel}`, text: `only ${alpha} here` }));
    await expectOutput(searcher.call("send_message", { ...agent, to: `#${channel}`, text: `${alpha} and ${beta} together` }));
    await expectOutput(searcher.call("send_message", { ...agent, to: `#${channel}`, text: `${alpha} ${beta} ${gamma} all three` }));
  });

  test("a word nobody wrote returns nothing", async () => {
    const found = await expectOutput(searcher.call("search_messages", { ...agent, query: `zqx${run}vw` }));
    assert.deepEqual(found.results, []);
    assert.equal(found.related, undefined);
  });

  test("with three or more words, a word-only hit needs two of them; the fullest match ranks first", async () => {
    const found = await expectOutput(searcher.call("search_messages", { ...agent, query: `${alpha} ${beta} ${gamma}`, detail: "full" }));
    const own = found.results.filter((result) => result.conversation === `#${channel}`);
    assert.deepEqual(own.map((result) => result.text), [`${alpha} ${beta} ${gamma} all three`, `${alpha} and ${beta} together`]);
    assert.ok(found.results.every((result) => result.matches === undefined && result.missing_terms === undefined));
  });

  test("recent top holds only messages with every word", async () => {
    const found = await expectOutput(searcher.call("search_messages", { ...agent, query: `${alpha} ${beta}`, sort: "recent", detail: "full" }));
    for (const best of found.top ?? []) assert.ok(best.text.includes(alpha) && best.text.includes(beta), best.text);
    assert.deepEqual(textsOf(found.results), [`${alpha} ${beta} ${gamma} all three`, `${alpha} and ${beta} together`]);
  });
});
