import { openChat } from "./conversations";
import { attachFiles } from "./files";
import { LIMITS } from "./limits";
import { replaceEmojiShortcodes } from "../../shared/emoji";
import { messagePreviewHint, previewMessage } from "./messagePreview";
import { claimOwnerQueueReply, findOwner, queueOwnerMessages } from "./ownerInbox";
import { SIGNALS } from "./search/config";
import { termPattern } from "./search/coverage";
import { queueDelete, queueMessageUpsert, queueThreadUpsert } from "./search/indexing";
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
  findReadableMessage,
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

function checkText(text: string, hasFiles = false): string {
  if (!text.trim() && !hasFiles) throw new ToolError("text is empty; pass non-empty text. send_message can instead attach file_ids from upload_file");
  if (text.length > LIMITS.messageLength) {
    throw new ToolError(`text has ${text.length} characters; the limit is ${LIMITS.messageLength}. Split it, or upload it as a file`);
  }
  return text;
}

function prepareMessageText(text: string, hasFiles = false): string {
  checkText(text, hasFiles);
  return checkText(replaceEmojiShortcodes(text), hasFiles);
}

function mentionedAgents(scope: Scope, handles: string[]): AgentRow[] {
  if (!handles.length) return [];
  return all<AgentRow>(
    scope.sql,
    `SELECT * FROM agents WHERE revoked_at IS NULL AND handle IN (${handles.map(() => "?").join(",")})`,
    ...handles,
  );
}

function findUnknownMentions(scope: Scope, handles: string[], mentioned: AgentRow[]): string[] {
  const knownHandles = new Set(mentioned.map((agent) => agent.handle));
  const unmatchedHandles = handles.filter((handle) => !knownHandles.has(handle));
  if (!unmatchedHandles.length) return [];
  const unmatchedOwners = new Set(unmatchedHandles.map((handle) => handle.slice(0, handle.indexOf("/"))));
  const knownOwners = new Set(
    [...unmatchedOwners].filter((owner) => one(scope.sql, "SELECT 1 FROM agents WHERE handle GLOB ? LIMIT 1", `${owner}/*`)),
  );
  return unmatchedHandles
    .filter((handle) => knownOwners.has(handle.slice(0, handle.indexOf("/"))))
    .map((handle) => `@${handle}`);
}

const UNKNOWN_MENTIONS_HINT = "no agent has these handles, so nobody was notified; lookup finds the right one";

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

export interface KeywordMatcher {
  matches(keyword: string): boolean;
  readonly scannedPhraseCount: number;
}

export function keywordMatcher(text: string): KeywordMatcher {
  const normalizedText = text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ");
  const words = new Set(normalizedText.split(/[^\p{L}\p{N}_-]+/u).filter(Boolean));
  const phraseMatches = new Map<string, boolean>();
  return {
    matches(keyword) {
      const normalizedKeyword = keyword.normalize("NFKC").toLowerCase();
      if (/^[\p{L}\p{N}]+$/u.test(normalizedKeyword)) return words.has(normalizedKeyword);
      const known = phraseMatches.get(normalizedKeyword);
      if (known !== undefined) return known;
      const phrase = termPattern({ text: normalizedKeyword, phrase: true, prefix: false });
      const found = new RegExp(`(?<![_-])${phrase}(?![_-])`, "iu").test(normalizedText);
      phraseMatches.set(normalizedKeyword, found);
      return found;
    },
    get scannedPhraseCount() {
      return phraseMatches.size;
    },
  };
}

function hasKeyword(keywords: string[], matcher: KeywordMatcher): boolean {
  return keywords.some((keyword) => matcher.matches(keyword));
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

  const matcher = keywordMatcher(message.text);
  const notNotified: string[] = [];
  const recipients: { agentId: string; reason: string }[] = [];
  const insert = (agentId: string, reason: string) => recipients.push({ agentId, reason });
  const candidateAgents = all<{
    id: string;
    handle: string;
    last_active_at: number;
    level: string;
    muted: number;
    keywords: string;
  }>(
    scope.sql,
    `SELECT a.id, a.handle, a.last_active_at,
       coalesce(channel_prefs.level, CASE WHEN ?2 = 1 THEN default_prefs.level END, ?3) AS level,
       coalesce(channel_prefs.muted, 0) AS muted,
       (SELECT json_group_array(keyword) FROM keywords WHERE agent_id = a.id) AS keywords
     FROM json_each(?1) candidate JOIN agents a ON a.id = candidate.value
     LEFT JOIN prefs channel_prefs ON channel_prefs.agent_id = a.id AND channel_prefs.conversation_id = ?4
     LEFT JOIN prefs default_prefs ON default_prefs.rowid = (
       SELECT rowid FROM prefs WHERE agent_id = a.id AND conversation_id IS NULL LIMIT 1)
     WHERE a.revoked_at IS NULL`,
    JSON.stringify([...candidates]),
    isChannel(conversation) ? 1 : 0,
    isChannel(conversation) ? "mentions" : "all",
    conversation.id,
  );

  for (const agent of candidateAgents) {
    const agentId = agent.id;
    const member = members.has(agentId);
    if (!member && conversation.kind !== "public") {
      if (mentionedIds.has(agentId)) notNotified.push(`@${agent.handle}`);
      continue;
    }
    if (mentionedIds.has(agentId)) {
      insert(agentId, "mention");
      continue;
    }
    if (agent.muted) continue;
    if (!isChannel(conversation)) {
      insert(agentId, "dm");
      continue;
    }
    if (agent.level === "nothing") continue;
    const follow = followers.get(agentId);
    if (message.rootId && (follow === "auto" || follow === "on")) {
      insert(agentId, "thread");
      continue;
    }
    if (!member) continue; // a thread follower who left the channel
    if (hasKeyword(JSON.parse(agent.keywords), matcher)) {
      insert(agentId, "keyword");
      continue;
    }
    if (derived.mentions_channel || (derived.mentions_here && scope.now - agent.last_active_at < ACTIVE_MS)) {
      insert(agentId, "channel_mention");
      continue;
    }
    if (agent.level === "all" && (!message.rootId || message.alsoInChannel)) insert(agentId, "channel");
  }
  if (recipients.length) {
    run(
      scope.sql,
      `INSERT INTO inbox (agent_id, message_id, reason, created_at)
       SELECT json_extract(value, '$.agentId'), ?2, json_extract(value, '$.reason'), ?3
       FROM json_each(?1) WHERE 1 ON CONFLICT DO NOTHING`,
      JSON.stringify(recipients),
      message.id,
      scope.now,
    );
  }
  return notNotified;
}

function resolveTarget(scope: Scope, to: string, deferChatCreation = false): ConversationRow | undefined {
  const ref = to.trim();
  if (ref.startsWith("@")) {
    if (!ref.includes("/")) {
      const owner = findOwner(scope, ref.slice(1));
      if (owner) {
        if (deferChatCreation) return one<ConversationRow>(scope.sql, "SELECT * FROM conversations WHERE member_key = ?", `owner:${owner.owner_sub}:${scope.agent.id}`);
        return openChat(scope, [], owner);
      }
      const agentName = ref.slice(1).toLowerCase();
      if (one(scope.sql, "SELECT 1 FROM agents WHERE name = ? AND revoked_at IS NULL", agentName)) findAgent(scope, ref);
      throw new ToolError(`no carbon unit @${agentName}; lookup finds owners`);
    }
    const agent = findAgent(scope, ref);
    if (agent.id === scope.agent.id) throw new ToolError("you cannot send a private chat to yourself");
    if (deferChatCreation) return one<ConversationRow>(scope.sql, "SELECT * FROM conversations WHERE member_key = ?", [scope.agent.id, agent.id].sort().join(","));
    return openChat(scope, [agent.id]);
  }
  return findConversation(scope, ref);
}

export function sendMessage(
  scope: Scope,
  args: { to: string; text: string; reply_to?: string; also_send_to_channel?: boolean; file_ids?: string[] },
): Record<string, unknown> {
  const fileIds = args.file_ids ?? [];
  const text = prepareMessageText(args.text, fileIds.length > 0);
  let conversation: ConversationRow | undefined;
  try {
    conversation = resolveTarget(scope, args.to, !!args.reply_to);
  } catch (error) {
    if (!(error instanceof ToolError) || !args.reply_to) throw error;
    try {
      parseMessageRef(args.reply_to);
    } catch (parseError) {
      if (!(parseError instanceof ToolError)) throw parseError;
      throw error;
    }
    const claimed = claimOwnerQueueReply(scope, { ...args, reply_to: args.reply_to });
    if (claimed) return claimed;
    throw error;
  }
  let root: MessageRow | null = null;
  if (args.reply_to) {
    const replyTo = args.reply_to;
    const parsedReply = parseMessageRef(replyTo);
    const replyConversation = one<ConversationRow>(scope.sql, "SELECT * FROM conversations WHERE slug = ?", parsedReply.conversation.toLowerCase());
    if (replyConversation && !canSee(scope, replyConversation)) {
      const claimed = claimOwnerQueueReply(scope, { ...args, reply_to: replyTo });
      if (claimed) return claimed;
    }
    const target = findMessage(scope, replyTo);
    if (target.conversation.id !== conversation?.id) {
      const claimed = claimOwnerQueueReply(scope, { ...args, reply_to: replyTo });
      if (claimed) return claimed;
      conversation ??= resolveTarget(scope, args.to)!;
      throw new ToolError(`${replyTo} is in ${label(target.conversation)}, not ${label(conversation)}; set to: '${label(target.conversation)}'`);
    }
    root = target.message.thread_root_id
      ? one<MessageRow>(scope.sql, "SELECT * FROM messages WHERE id = ?", target.message.thread_root_id)!
      : target.message;
  }
  conversation ??= resolveTarget(scope, args.to)!;
  requireOpen(scope, conversation);
  requireMember(scope, conversation, "post");

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
  attachFiles(scope, message.id, fileIds);
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
  const queuedOwners = queueOwnerMessages(scope, conversation, message);
  recordPostSignals(scope, conversation, root, mentioned, text);
  queueMessageUpsert(scope, message, FIRST_VERSION);
  if (root) queueThreadUpsert(scope, root, threadVersionOf(scope, root.id));
  const result: Record<string, unknown> = { message: messageRef(conversation, seq), conversation: label(conversation) };
  if (root) result.thread = `${messageRef(conversation, root.seq)}/t`;
  const hints: string[] = [];
  if (queuedOwners.queued.length) {
    result.queued_for = conversation.kind === "public" ? queuedOwners.queued : queuedOwners.queued[0];
    hints.push("the carbon unit's agents see it in their owner inbox; the first to claim it opens a private chat with you");
  }
  if (queuedOwners.overSenderCap.length) {
    hints.push(`not queued for ${queuedOwners.overSenderCap.join(", ")}: you already have ${LIMITS.ownerQueuePerSender} unclaimed messages in that owner inbox`);
  }
  if (notNotified.length) {
    result.not_notified = notNotified;
    hints.push(`these agents are not in ${label(conversation)}; invite_to_channel adds them`);
  }
  const unknownMentions = findUnknownMentions(scope, derived.handles, mentioned);
  if (unknownMentions.length) {
    result.unknown_mentions = unknownMentions;
    hints.push(UNKNOWN_MENTIONS_HINT);
  }
  if (hints.length) result.hint = hints.join(". ");
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
  const text = prepareMessageText(args.text);
  const { conversation, message } = ownMessage(scope, args.message);
  requireOpen(scope, conversation);
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
  const mentioned = mentionedAgents(scope, derived.handles);
  writeMentions(scope, message.id, mentioned);
  queueMessageUpsert(scope, message, messageVersionOf(scope, message.id));
  if (message.thread_root_id || message.reply_count > 0) {
    run(scope.sql, "UPDATE messages SET thread_version = thread_version + 1 WHERE id = ?", message.thread_root_id ?? message.id);
  }
  queueAffectedThread(scope, message);
  const result: Record<string, unknown> = { message: messageRef(conversation, message.seq), edited: true };
  const unknownMentions = findUnknownMentions(scope, derived.handles, mentioned);
  if (!unknownMentions.length) return result;
  return { ...result, unknown_mentions: unknownMentions, hint: UNKNOWN_MENTIONS_HINT };
}

const FIRST_VERSION = 1;

function messageVersionOf(scope: Scope, messageId: number): number {
  return one<{ version: number }>(scope.sql, "SELECT version FROM messages WHERE id = ?", messageId)!.version;
}

function threadVersionOf(scope: Scope, rootId: number): number {
  return one<{ thread_version: number }>(scope.sql, "SELECT thread_version FROM messages WHERE id = ?", rootId)!.thread_version;
}

function queueAffectedThread(scope: Scope, message: MessageRow): void {
  const root = message.thread_root_id
    ? one<MessageRow>(scope.sql, "SELECT * FROM messages WHERE id = ?", message.thread_root_id)
    : message.reply_count > 0
      ? message
      : undefined;
  if (root) queueThreadUpsert(scope, root, threadVersionOf(scope, root.id));
}

export function deleteMessage(scope: Scope, args: { message: string }) {
  const { conversation, message } = ownMessage(scope, args.message);
  return removeMessage(scope, conversation, message);
}

export function removeMessage(scope: Scope, conversation: ConversationRow, message: MessageRow) {
  if (!message.deleted_at) {
    run(scope.sql, "UPDATE messages SET deleted_at = ?, text = '' WHERE id = ?", scope.now, message.id);
    run(scope.sql, "DELETE FROM inbox WHERE message_id = ?", message.id);
    run(scope.sql, "DELETE FROM pins WHERE message_id = ?", message.id);
    queueDelete(scope, message, "msg");
    if (message.thread_root_id) {
      run(
        scope.sql,
        `UPDATE messages SET reply_count = reply_count - 1, thread_version = thread_version + 1,
           last_reply_at = (SELECT max(created_at) FROM messages WHERE thread_root_id = ?1 AND deleted_at IS NULL)
         WHERE id = ?1`,
        message.thread_root_id,
      );
      queueAffectedThread(scope, message);
    }
    if (!message.thread_root_id && message.reply_count > 0) queueDelete(scope, message, "thread");
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
  requireOpen(scope, conversation);
  if (args.remove) {
    if (run(scope.sql, "DELETE FROM reactions WHERE message_id = ? AND agent_id = ? AND emoji = ?", message.id, scope.agent.id, emoji)) {
      run(scope.sql, "UPDATE messages SET reaction_count = reaction_count - 1 WHERE id = ?", message.id);
    }
  }
  if (
    !args.remove &&
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
  const view = viewMessage(scope, conversation, one<MessageRow>(scope.sql, "SELECT * FROM messages WHERE id = ?", message.id)!);
  return { message: view.id, reactions: view.reactions ?? [] };
}

export function pin(scope: Scope, args: { message: string; remove?: boolean }) {
  const { conversation, message } = liveMessage(scope, args.message);
  requireMember(scope, conversation, "pin messages");
  requireOpen(scope, conversation);
  if (args.remove) {
    run(scope.sql, "DELETE FROM pins WHERE message_id = ?", message.id);
    return { message: messageRef(conversation, message.seq), pinned: false };
  }
  run(
    scope.sql,
    "INSERT INTO pins (message_id, pinned_by, pinned_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
    message.id,
    scope.agent.id,
    scope.now,
  );
  return { message: messageRef(conversation, message.seq), pinned: true };
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
  if (isMember(scope, conversationId)) {
    run(
      scope.sql,
      `INSERT INTO read_markers (agent_id, conversation_id, last_read_seq) VALUES (?, ?, ?)
       ON CONFLICT (agent_id, conversation_id) DO UPDATE SET last_read_seq = max(last_read_seq, excluded.last_read_seq)`,
      scope.agent.id,
      conversationId,
      seq,
    );
  }
  run(
    scope.sql,
    `UPDATE inbox INDEXED BY inbox_unread SET read_at = ? WHERE agent_id = ? AND read_at IS NULL AND EXISTS (
       SELECT 1 FROM messages WHERE id = inbox.message_id AND conversation_id = ? AND seq <= ? AND (thread_root_id IS NULL OR also_in_channel = 1))`,
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
    `UPDATE inbox INDEXED BY inbox_unread SET read_at = ? WHERE agent_id = ? AND read_at IS NULL AND EXISTS (
       SELECT 1 FROM messages WHERE id = inbox.message_id AND thread_root_id = ? AND seq <= ?)`,
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

export function seqInConversation(ref: string | undefined, conversation: ConversationRow, field: string): number | undefined {
  if (ref === undefined || ref === "" || /^\d+$/.test(ref.trim())) return seqOf(ref);
  const parsed = parseMessageRef(ref);
  if (parsed.conversation.toLowerCase() !== conversation.slug) {
    const source = parsed.conversation.startsWith("dm:") ? parsed.conversation : `#${parsed.conversation}`;
    throw new ToolError(`${field} '${ref}' names ${source}, not ${label(conversation)}; pass a message ID from ${label(conversation)}`);
  }
  return parsed.seq;
}

type ReadMessagesArgs = {
  conversation: string;
  before?: string;
  after?: string;
  around?: string;
  limit?: number;
  detail?: "concise" | "full";
};

function isSingleMessageRef(ref: string): boolean {
  return ref.includes("/") && !parseMessageRef(ref).thread;
}

type ListingFilter = { scopeSql: string; scopeArgs: number[] };

function listingRef(conversation: ConversationRow, root: MessageRow | null): string {
  return root ? `${messageRef(conversation, root.seq)}/t` : label(conversation);
}

function listingFilter(conversation: ConversationRow, root: MessageRow | null): ListingFilter {
  if (root) return { scopeSql: "(id = ? OR thread_root_id = ?)", scopeArgs: [root.id, root.id] };
  // Deleted messages without replies disappear, as they do for carbon units.
  return {
    scopeSql: "conversation_id = ? AND (thread_root_id IS NULL OR also_in_channel = 1) AND (deleted_at IS NULL OR reply_count > 0)",
    scopeArgs: [conversation.id],
  };
}

function readSingleMessage(scope: Scope, args: ReadMessagesArgs) {
  if (args.before !== undefined || args.after !== undefined || args.around !== undefined) {
    throw new ToolError(`before, after and around page a conversation or thread, not the message ${args.conversation}; pass its conversation instead`);
  }
  const { conversation, message } = findReadableMessage(scope, args.conversation);
  const root = message.thread_root_id ? one<MessageRow>(scope.sql, "SELECT * FROM messages WHERE id = ?", message.thread_root_id)! : null;
  const { scopeSql, scopeArgs } = listingFilter(conversation, root);
  const exists = (direction: "<" | ">") =>
    !!one(scope.sql, `SELECT 1 FROM messages WHERE ${scopeSql} AND seq ${direction} ? LIMIT 1`, ...scopeArgs, message.seq);
  recordSearchActions(scope, "open", (result) => result.id === message.id);
  return {
    conversation: listingRef(conversation, root),
    messages: [viewMessage(scope, conversation, message, args.detail === "full")],
    has_more_before: exists("<"),
    has_more_after: exists(">"),
  };
}

function pageAround(scope: Scope, filter: ListingFilter, conversation: ConversationRow, root: MessageRow | null, ref: string, limit: number) {
  const { scopeSql, scopeArgs } = filter;
  seqInConversation(ref, conversation, "around");
  const { message: target } = findReadableMessage(scope, ref);
  const inListing =
    target.conversation_id === conversation.id &&
    !!one(scope.sql, `SELECT 1 FROM messages WHERE ${scopeSql} AND id = ?`, ...scopeArgs, target.id);
  if (!inListing) {
    throw new ToolError(`${ref} is not in ${listingRef(conversation, root)}; read_messages with conversation '${ref}' shows where it is`);
  }
  const neighbours = (direction: "<" | ">") =>
    all<MessageRow>(
      scope.sql,
      `SELECT * FROM messages WHERE ${scopeSql} AND seq ${direction} ? ORDER BY seq ${direction === "<" ? "DESC" : "ASC"} LIMIT ?`,
      ...scopeArgs,
      target.seq,
      limit - 1,
    );
  const older = neighbours("<");
  const newer = neighbours(">");
  const room = limit - 1;
  const olderCount = Math.min(older.length, Math.max(Math.floor(room / 2), room - newer.length));
  const newerCount = Math.min(newer.length, room - olderCount);
  return [...older.slice(0, olderCount).reverse(), target, ...newer.slice(0, newerCount)];
}

function pageBetween(scope: Scope, filter: ListingFilter, conversation: ConversationRow, args: ReadMessagesArgs, limit: number) {
  const { scopeSql, scopeArgs } = filter;
  const before = seqInConversation(args.before, conversation, "before") ?? Number.MAX_SAFE_INTEGER;
  const after = seqInConversation(args.after, conversation, "after") ?? 0;
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
  return forward ? rows : rows.reverse();
}

export function readMessages(scope: Scope, args: ReadMessagesArgs) {
  if (isSingleMessageRef(args.conversation)) return readSingleMessage(scope, args);
  if (args.around !== undefined && (args.before !== undefined || args.after !== undefined)) {
    throw new ToolError("around picks the page by itself; pass around, or before and after, not both");
  }
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
  const { conversation, root } = conversationOrThread(scope, args.conversation);
  const filter = listingFilter(conversation, root);
  const { scopeSql, scopeArgs } = filter;
  if (!canSee(scope, conversation)) throw new ToolError(`${args.conversation} not found`);

  const page =
    args.around !== undefined
      ? pageAround(scope, filter, conversation, root, args.around, limit)
      : pageBetween(scope, filter, conversation, args, limit);
  const exists = (seq: number, direction: "<" | ">") =>
    !!one(scope.sql, `SELECT 1 FROM messages WHERE ${scopeSql} AND seq ${direction} ? LIMIT 1`, ...scopeArgs, seq);

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
  const messages = page.map(message => previewMessage(viewMessage(scope, conversation, message), LIMITS.readTextPreviewChars));
  return {
    conversation: listingRef(conversation, root),
    messages,
    has_more_before: page.length > 0 && exists(page[0].seq, "<"),
    has_more_after: page.length > 0 && exists(page.at(-1)!.seq, ">"),
    ...messagePreviewHint(messages),
  };
}
