import { openChat } from "./conversations";
import { LIMITS } from "./limits";
import { SIGNALS } from "./search/config";
import {
  bumpAgentAffinity,
  bumpChannelAffinity,
  bumpMutualAffinity,
  messageRefText,
  recordSearchActions,
  type ResultMessage,
} from "./search/signals";
import {
  ToolError,
  all,
  canSee,
  findAgent,
  findConversation,
  findMessage,
  isChannel,
  isMember,
  label,
  messageRef,
  one,
  parseMessageRef,
  requireMember,
  requireOpen,
  run,
  viewMessage,
  type AgentRow,
  type ConversationRow,
  type MessageRow,
  type Scope,
} from "./store";

// Message tools that run inside the workspace object (DATA.md, Write rules;
// NOTIFICATIONS.md, Fan-out on write).

const ACTIVE_MS = 15 * 60 * 1000;
const AGENT_MENTION = /(?:^|[^\w@/])@([a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9_-]*)/gi;
const BROADCAST_MENTION = /(?:^|[^\w@/])@(channel|here)(?![\w./-])/gi;

interface Derived {
  has_link: number;
  has_code: number;
  mentions_channel: number;
  mentions_here: number;
  word_count: number;
  handles: string[];
}

function derive(text: string): Derived {
  const handles = new Set([...text.matchAll(AGENT_MENTION)].map((match) => match[1].toLowerCase()));
  const broadcasts = new Set([...text.matchAll(BROADCAST_MENTION)].map((match) => match[1].toLowerCase()));
  const mentionsChannel = broadcasts.has("channel");
  const mentionsHere = broadcasts.has("here");
  return {
    has_link: /https?:\/\/\S/i.test(text) ? 1 : 0,
    has_code: /```|`[^`\n]+`/.test(text) ? 1 : 0,
    mentions_channel: mentionsChannel ? 1 : 0,
    mentions_here: mentionsHere ? 1 : 0,
    word_count: text.split(/\s+/).filter(Boolean).length,
    handles: [...handles],
  };
}

function checkText(text: string): string {
  if (!text.trim()) throw new ToolError("text is empty");
  if (text.length > LIMITS.messageLength) {
    throw new ToolError(`text has ${text.length} characters; the limit is ${LIMITS.messageLength}. Split it, or upload it as a file`);
  }
  return text;
}

function mentionedAgents(scope: Scope, handles: string[]): AgentRow[] {
  if (!handles.length) return [];
  return all<AgentRow>(
    scope.sql,
    `SELECT * FROM agents WHERE revoked_at IS NULL AND handle IN (${handles.map(() => "?").join(",")})`,
    ...handles,
  );
}

function writeMentions(scope: Scope, messageId: number, agents: AgentRow[]): void {
  run(scope.sql, "DELETE FROM mentions WHERE message_id = ?", messageId);
  for (const agent of agents) {
    run(scope.sql, "INSERT INTO mentions (message_id, agent_id) VALUES (?, ?) ON CONFLICT DO NOTHING", messageId, agent.id);
  }
}

// 'auto' never overwrites an explicit 'on' or 'off'.
function autoFollow(scope: Scope, agentId: string, rootId: number): void {
  run(scope.sql, "INSERT INTO thread_follows (agent_id, root_id, state) VALUES (?, ?, 'auto') ON CONFLICT DO NOTHING", agentId, rootId);
}

export function effectivePrefs(
  scope: Scope,
  agentId: string,
  conversation: ConversationRow,
): { level: string; muted: boolean; inherited: boolean } {
  const own = one<{ level: string | null; muted: number }>(
    scope.sql,
    "SELECT level, muted FROM prefs WHERE agent_id = ? AND conversation_id = ?",
    agentId,
    conversation.id,
  );
  const inheritedLevel = isChannel(conversation) ? defaultLevel(scope, agentId) : "all";
  return { level: own?.level ?? inheritedLevel, muted: !!own?.muted, inherited: !own?.level };
}

export function defaultLevel(scope: Scope, agentId: string): string {
  return one<{ level: string | null }>(scope.sql, "SELECT level FROM prefs WHERE agent_id = ? AND conversation_id IS NULL", agentId)?.level ?? "mentions";
}

function hasKeyword(scope: Scope, agentId: string, words: Set<string>): boolean {
  return all<{ keyword: string }>(scope.sql, "SELECT keyword FROM keywords WHERE agent_id = ?", agentId).some((row) =>
    row.keyword.includes(" ") ? [...words].join(" ").includes(row.keyword) : words.has(row.keyword),
  );
}

// At most one inbox row per candidate, from the first rule that matches (NOTIFICATIONS.md).
function fanOut(
  scope: Scope,
  conversation: ConversationRow,
  message: { id: number; text: string; rootId: number | null; alsoInChannel: boolean },
  derived: Derived,
  mentioned: AgentRow[],
): string[] {
  const mentionedIds = new Set(mentioned.map((agent) => agent.id));
  const members = new Set(
    all<{ agent_id: string }>(scope.sql, "SELECT agent_id FROM members WHERE conversation_id = ?", conversation.id).map((row) => row.agent_id),
  );
  const followers = new Map<string, string>();
  if (message.rootId) {
    for (const row of all<{ agent_id: string; state: string }>(
      scope.sql,
      "SELECT agent_id, state FROM thread_follows WHERE root_id = ?",
      message.rootId,
    )) {
      followers.set(row.agent_id, row.state);
    }
  }
  const candidates = new Set([...members, ...mentionedIds, ...followers.keys()]);
  candidates.delete(scope.agent.id);

  const words = new Set(message.text.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean));
  const notNotified: string[] = [];
  const insert = (agentId: string, reason: string) =>
    run(
      scope.sql,
      "INSERT INTO inbox (agent_id, message_id, reason, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
      agentId,
      message.id,
      reason,
      scope.now,
    );

  for (const agentId of candidates) {
    const agent = one<AgentRow>(scope.sql, "SELECT * FROM agents WHERE id = ? AND revoked_at IS NULL", agentId);
    if (!agent) continue;
    const member = members.has(agentId);
    // Mentions of agents outside a private conversation reach no one.
    if (!member && conversation.kind !== "public") {
      if (mentionedIds.has(agentId)) notNotified.push(`@${agent.handle}`);
      continue;
    }
    if (mentionedIds.has(agentId)) {
      insert(agentId, "mention");
      continue;
    }
    const prefs = effectivePrefs(scope, agentId, conversation);
    if (prefs.muted) continue;
    if (!isChannel(conversation)) {
      insert(agentId, "dm");
      continue;
    }
    if (prefs.level === "nothing") continue;
    const follow = followers.get(agentId);
    if (message.rootId && (follow === "auto" || follow === "on")) {
      insert(agentId, "thread");
      continue;
    }
    if (!member) continue; // a thread follower who left the channel
    if (hasKeyword(scope, agentId, words)) {
      insert(agentId, "keyword");
      continue;
    }
    if (derived.mentions_channel || (derived.mentions_here && scope.now - agent.last_active_at < ACTIVE_MS)) {
      insert(agentId, "channel_mention");
      continue;
    }
    if (prefs.level === "all" && (!message.rootId || message.alsoInChannel)) insert(agentId, "channel");
  }
  return notNotified;
}

function resolveTarget(scope: Scope, to: string): ConversationRow {
  const ref = to.trim();
  if (ref.startsWith("@")) {
    const agent = findAgent(scope, ref);
    if (agent.id === scope.agent.id) throw new ToolError("you cannot send a private chat to yourself");
    return openChat(scope, [agent.id]);
  }
  return findConversation(scope, ref);
}

export function sendMessage(scope: Scope, args: { to: string; text: string; reply_to?: string; also_send_to_channel?: boolean }) {
  const text = checkText(args.text);
  let conversation = resolveTarget(scope, args.to);
  let root: MessageRow | null = null;
  if (args.reply_to) {
    const target = findMessage(scope, args.reply_to);
    if (target.conversation.id !== conversation.id) {
      throw new ToolError(`${args.reply_to} is in ${label(target.conversation)}, not ${label(conversation)}; set to: '${label(target.conversation)}'`);
    }
    // Replies to a reply go to the same thread.
    root = target.message.thread_root_id
      ? one<MessageRow>(scope.sql, "SELECT * FROM messages WHERE id = ?", target.message.thread_root_id)!
      : target.message;
  }
  requireMember(scope, conversation, "post");
  requireOpen(conversation);

  const derived = derive(text);
  if ((derived.mentions_channel || derived.mentions_here) && !isChannel(conversation)) {
    derived.mentions_channel = 0;
    derived.mentions_here = 0;
  }
  const seq = conversation.last_seq + 1;
  const alsoInChannel = !!(root && args.also_send_to_channel && isChannel(conversation));
  run(
    scope.sql,
    `INSERT INTO messages (conversation_id, seq, author_id, thread_root_id, also_in_channel, text, created_at,
       has_link, has_code, mentions_channel, mentions_here, word_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    conversation.id,
    seq,
    scope.agent.id,
    root?.id ?? null,
    alsoInChannel ? 1 : 0,
    text,
    scope.now,
    derived.has_link,
    derived.has_code,
    derived.mentions_channel,
    derived.mentions_here,
    derived.word_count,
  );
  const message = one<MessageRow>(scope.sql, "SELECT * FROM messages WHERE conversation_id = ? AND seq = ?", conversation.id, seq)!;
  const mentioned = mentionedAgents(scope, derived.handles);
  writeMentions(scope, message.id, mentioned);
  run(scope.sql, "UPDATE conversations SET last_seq = ?, last_message_at = ? WHERE id = ?", seq, scope.now, conversation.id);
  conversation = { ...conversation, last_seq: seq, last_message_at: scope.now };

  if (root) {
    run(
      scope.sql,
      "UPDATE messages SET reply_count = reply_count + 1, last_reply_at = ?, thread_version = thread_version + 1 WHERE id = ?",
      scope.now,
      root.id,
    );
    autoFollow(scope, root.author_id, root.id);
    autoFollow(scope, scope.agent.id, root.id);
    for (const agent of mentioned) autoFollow(scope, agent.id, root.id);
    markThreadRead(scope, root.id, seq);
  }
  if (!root || alsoInChannel) markConversationRead(scope, conversation.id, seq);

  const notNotified = fanOut(scope, conversation, { id: message.id, text, rootId: root?.id ?? null, alsoInChannel }, derived, mentioned);
  recordPostSignals(scope, conversation, root, mentioned, text);
  const result: Record<string, unknown> = { message: viewMessage(scope, conversation, message) };
  if (notNotified.length) {
    result.not_notified = notNotified;
    result.hint = `these agents are not in ${label(conversation)}; invite_to_channel adds them`;
  }
  return result;
}

function citesResult(text: string, result: ResultMessage): boolean {
  return text.includes(messageRefText(result)) || text.includes(`/admin/c/${encodeURIComponent(result.slug)}#${result.seq}`);
}

function recordPostSignals(scope: Scope, conversation: ConversationRow, root: MessageRow | null, mentioned: AgentRow[], text: string): void {
  bumpChannelAffinity(scope, conversation.id, SIGNALS.channelPost);
  for (const agent of mentioned) bumpAgentAffinity(scope, scope.agent.id, agent.id, SIGNALS.mention);
  if (root) {
    const threadParticipants = new Set([
      root.author_id,
      ...all<{ author_id: string }>(scope.sql, "SELECT DISTINCT author_id FROM messages WHERE thread_root_id = ?", root.id).map(
        (row) => row.author_id,
      ),
    ]);
    for (const participant of threadParticipants) bumpMutualAffinity(scope, scope.agent.id, participant, SIGNALS.threadReply);
    recordSearchActions(scope, "reply", (result) => result.id === root.id || result.thread_root_id === root.id);
  }
  if (!isChannel(conversation)) {
    for (const { agent_id } of all<{ agent_id: string }>(scope.sql, "SELECT agent_id FROM members WHERE conversation_id = ?", conversation.id)) {
      bumpMutualAffinity(scope, scope.agent.id, agent_id, SIGNALS.privateChatMessage);
    }
  }
  recordSearchActions(scope, "cite", (result) => citesResult(text, result));
}

function ownMessage(scope: Scope, ref: string) {
  const found = findMessage(scope, ref);
  if (found.message.author_id !== scope.agent.id) throw new ToolError("you can change only your own messages");
  return found;
}

export function editMessage(scope: Scope, args: { message: string; text: string }) {
  const text = checkText(args.text);
  const { conversation, message } = ownMessage(scope, args.message);
  if (message.deleted_at) throw new ToolError(`${args.message} is deleted`);
  const derived = derive(text);
  run(
    scope.sql,
    `UPDATE messages SET text = ?, edited_at = ?, has_link = ?, has_code = ?, mentions_channel = ?, mentions_here = ?,
       word_count = ?, version = version + 1 WHERE id = ?`,
    text,
    scope.now,
    derived.has_link,
    derived.has_code,
    derived.mentions_channel,
    derived.mentions_here,
    derived.word_count,
    message.id,
  );
  writeMentions(scope, message.id, mentionedAgents(scope, derived.handles));
  return { message: viewMessage(scope, conversation, one<MessageRow>(scope.sql, "SELECT * FROM messages WHERE id = ?", message.id)!) };
}

export function deleteMessage(scope: Scope, args: { message: string }) {
  const { conversation, message } = ownMessage(scope, args.message);
  if (!message.deleted_at) {
    run(scope.sql, "UPDATE messages SET deleted_at = ?, text = '' WHERE id = ?", scope.now, message.id);
    run(scope.sql, "DELETE FROM inbox WHERE message_id = ?", message.id);
    run(scope.sql, "DELETE FROM pins WHERE message_id = ?", message.id);
  }
  return { message: messageRef(conversation, message.seq), deleted: true };
}

function liveMessage(scope: Scope, ref: string) {
  const found = findMessage(scope, ref);
  if (found.message.deleted_at) throw new ToolError(`${ref} is deleted`);
  return found;
}

export function react(scope: Scope, args: { message: string; emoji: string; remove?: boolean }) {
  const emoji = args.emoji.trim().toLowerCase().replace(/^:|:$/g, "");
  if (!/^[a-z0-9_+-]{1,32}$/.test(emoji)) throw new ToolError(`'${args.emoji}' is not an emoji shortcode; use a name like 'rocket' or '+1'`);
  const { conversation, message } = liveMessage(scope, args.message);
  if (args.remove) {
    if (run(scope.sql, "DELETE FROM reactions WHERE message_id = ? AND agent_id = ? AND emoji = ?", message.id, scope.agent.id, emoji)) {
      run(scope.sql, "UPDATE messages SET reaction_count = reaction_count - 1 WHERE id = ?", message.id);
    }
  } else if (
    run(
      scope.sql,
      "INSERT INTO reactions (message_id, agent_id, emoji, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
      message.id,
      scope.agent.id,
      emoji,
      scope.now,
    )
  ) {
    run(scope.sql, "UPDATE messages SET reaction_count = reaction_count + 1 WHERE id = ?", message.id);
    bumpAgentAffinity(scope, scope.agent.id, message.author_id, SIGNALS.reaction);
    recordSearchActions(scope, "react", (result) => result.id === message.id);
  }
  return { message: viewMessage(scope, conversation, one<MessageRow>(scope.sql, "SELECT * FROM messages WHERE id = ?", message.id)!) };
}

export function pin(scope: Scope, args: { message: string; remove?: boolean }) {
  const { conversation, message } = liveMessage(scope, args.message);
  requireMember(scope, conversation, "pin messages");
  if (args.remove) run(scope.sql, "DELETE FROM pins WHERE message_id = ?", message.id);
  else {
    run(
      scope.sql,
      "INSERT INTO pins (message_id, pinned_by, pinned_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      message.id,
      scope.agent.id,
      scope.now,
    );
  }
  return { message: messageRef(conversation, message.seq), pinned: !args.remove };
}

export function save(scope: Scope, args: { message: string; remove?: boolean }) {
  const { conversation, message } = findMessage(scope, args.message);
  if (args.remove) run(scope.sql, "DELETE FROM saves WHERE agent_id = ? AND message_id = ?", scope.agent.id, message.id);
  else {
    run(
      scope.sql,
      "INSERT INTO saves (agent_id, message_id, saved_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      scope.agent.id,
      message.id,
      scope.now,
    );
    recordSearchActions(scope, "save", (result) => result.id === message.id);
  }
  return { message: messageRef(conversation, message.seq), saved: !args.remove };
}

export function threadRoot(scope: Scope, ref: string): { conversation: ConversationRow; root: MessageRow } {
  const { conversation, message } = findMessage(scope, ref);
  const root = message.thread_root_id ? one<MessageRow>(scope.sql, "SELECT * FROM messages WHERE id = ?", message.thread_root_id)! : message;
  return { conversation, root };
}

export function conversationOrThread(scope: Scope, ref: string): { conversation: ConversationRow; root: MessageRow | null } {
  if (!ref.includes("/")) return { conversation: findConversation(scope, ref), root: null };
  const parsed = parseMessageRef(ref);
  if (!parsed.thread) {
    const channelRef = parsed.conversation.startsWith("dm:") ? parsed.conversation : `#${parsed.conversation}`;
    throw new ToolError(
      `${ref} is a message, not a conversation; for its thread pass '${ref}/t', or pass '${channelRef}' with up_to/before/after '${ref}'`,
    );
  }
  return threadRoot(scope, ref);
}

export function followThread(scope: Scope, args: { thread: string; remove?: boolean }) {
  const { conversation, root } = threadRoot(scope, args.thread);
  const state = args.remove ? "off" : "on";
  run(
    scope.sql,
    `INSERT INTO thread_follows (agent_id, root_id, state) VALUES (?, ?, ?)
     ON CONFLICT (agent_id, root_id) DO UPDATE SET state = excluded.state`,
    scope.agent.id,
    root.id,
    state,
  );
  return { thread: `${messageRef(conversation, root.seq)}/t`, following: !args.remove };
}

// Markers only move forward. Reading also clears the matching inbox rows.
export function markConversationRead(scope: Scope, conversationId: number, seq: number): void {
  if (!isMember(scope, conversationId)) return;
  run(
    scope.sql,
    `INSERT INTO read_markers (agent_id, conversation_id, last_read_seq) VALUES (?, ?, ?)
     ON CONFLICT (agent_id, conversation_id) DO UPDATE SET last_read_seq = max(last_read_seq, excluded.last_read_seq)`,
    scope.agent.id,
    conversationId,
    seq,
  );
  run(
    scope.sql,
    `UPDATE inbox SET read_at = ? WHERE agent_id = ? AND read_at IS NULL AND message_id IN (
       SELECT id FROM messages WHERE conversation_id = ? AND seq <= ? AND (thread_root_id IS NULL OR also_in_channel = 1))`,
    scope.now,
    scope.agent.id,
    conversationId,
    seq,
  );
}

export function markThreadRead(scope: Scope, rootId: number, seq: number): void {
  run(
    scope.sql,
    `INSERT INTO thread_reads (agent_id, root_id, last_read_seq) VALUES (?, ?, ?)
     ON CONFLICT (agent_id, root_id) DO UPDATE SET last_read_seq = max(last_read_seq, excluded.last_read_seq)`,
    scope.agent.id,
    rootId,
    seq,
  );
  run(
    scope.sql,
    `UPDATE inbox SET read_at = ? WHERE agent_id = ? AND read_at IS NULL AND message_id IN (
       SELECT id FROM messages WHERE thread_root_id = ? AND seq <= ?)`,
    scope.now,
    scope.agent.id,
    rootId,
    seq,
  );
}

export function seqOf(ref: string | undefined): number | undefined {
  if (ref === undefined || ref === "") return undefined;
  if (/^\d+$/.test(ref.trim())) return Number(ref);
  return parseMessageRef(ref).seq;
}

export function readMessages(scope: Scope, args: { conversation: string; before?: string; after?: string; limit?: number }) {
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
  const before = seqOf(args.before) ?? Number.MAX_SAFE_INTEGER;
  const after = seqOf(args.after) ?? 0;
  const { conversation, root } = conversationOrThread(scope, args.conversation);
  let scopeSql: string;
  let scopeArgs: number[];
  if (root) {
    scopeSql = "(id = ? OR thread_root_id = ?)";
    scopeArgs = [root.id, root.id];
  } else {
    // Deleted messages without replies disappear, as they do for carbon units.
    scopeSql = "conversation_id = ? AND (thread_root_id IS NULL OR also_in_channel = 1) AND (deleted_at IS NULL OR reply_count > 0)";
    scopeArgs = [conversation.id];
  }
  if (!canSee(scope, conversation)) throw new ToolError(`${args.conversation} not found`);

  // Newest first unless the caller pages forward with `after`.
  const forward = args.after !== undefined && args.before === undefined;
  const rows = all<MessageRow>(
    scope.sql,
    `SELECT * FROM messages WHERE ${scopeSql} AND seq > ? AND seq < ? ORDER BY seq ${forward ? "ASC" : "DESC"} LIMIT ?`,
    ...scopeArgs,
    after,
    before,
    limit,
  );
  const page = rows.slice(0, limit);
  const exists = (seq: number, direction: "<" | ">") =>
    !!one(scope.sql, `SELECT 1 FROM messages WHERE ${scopeSql} AND seq ${direction} ? LIMIT 1`, ...scopeArgs, seq);
  if (!forward) page.reverse();

  const newest = page.at(-1)?.seq;
  if (newest !== undefined) {
    const lastReadSeq = root
      ? one<{ last_read_seq: number }>(scope.sql, "SELECT last_read_seq FROM thread_reads WHERE agent_id = ? AND root_id = ?", scope.agent.id, root.id)
      : one<{ last_read_seq: number }>(
          scope.sql,
          "SELECT last_read_seq FROM read_markers WHERE agent_id = ? AND conversation_id = ?",
          scope.agent.id,
          conversation.id,
        );
    if (newest > (lastReadSeq?.last_read_seq ?? 0)) bumpChannelAffinity(scope, conversation.id, SIGNALS.channelRead);
    if (root) markThreadRead(scope, root.id, newest);
    else markConversationRead(scope, conversation.id, newest);
    const openedRootId = root?.id;
    recordSearchActions(scope, "open", (result) =>
      openedRootId === undefined
        ? result.conversation_id === conversation.id
        : result.id === openedRootId || result.thread_root_id === openedRootId,
    );
  }
  return {
    conversation: root ? `${messageRef(conversation, root.seq)}/t` : label(conversation),
    messages: page.map((message) => viewMessage(scope, conversation, message)),
    has_more_before: page.length > 0 && exists(page[0].seq, "<"),
    has_more_after: page.length > 0 && exists(page.at(-1)!.seq, ">"),
  };
}
