import { buildBrief } from "./brief";
import { sha256Hex } from "./ids";
import { LIMITS } from "./limits";
import {
  conversationOrThread,
  defaultLevel,
  effectivePrefs,
  markConversationRead,
  markThreadRead,
  seqOf,
} from "./messages";
import {
  ToolError,
  all,
  nameInUseRefusal,
  findConversation,
  findMessage,
  isMember,
  label,
  messageRef,
  one,
  run,
  viewMessage,
  type ConversationRow,
  type MessageRow,
  type Scope,
} from "./store";
import { newStreamTicket, streamUrl } from "./stream";

const INBOX_PAGE_DEFAULT = 20;
const INBOX_PAGE_MAX = 50;
const KEYWORD_LIMIT = 20;
const KEYWORD_MAX_LENGTH = 50;
const REASONS_MOST_URGENT_FIRST = ["mention", "dm", "thread", "keyword", "channel_mention", "channel"];

interface InboxRow {
  message_id: number;
  reason: string;
  created_at: number;
}

function encodeCursor(row: InboxRow): string {
  return `${row.created_at}.${row.message_id}`;
}

function decodeCursor(cursor: string | undefined): [number, number] {
  if (!cursor) return [0, 0];
  const [createdAt, messageId] = cursor.split(".").map(Number);
  if (!Number.isFinite(createdAt) || !Number.isFinite(messageId)) throw new ToolError("cursor is not valid; pass next_cursor from the previous page");
  return [createdAt, messageId];
}

function unreadChannels(scope: Scope) {
  return all<{ slug: string; unread: number }>(
    scope.sql,
    `SELECT c.slug, (
       SELECT count(*) FROM messages m
       WHERE m.conversation_id = c.id AND m.seq > r.last_read_seq AND m.deleted_at IS NULL
         AND m.author_id != ?1 AND (m.thread_root_id IS NULL OR m.also_in_channel = 1)
     ) AS unread
     FROM members mem
     JOIN conversations c ON c.id = mem.conversation_id
     JOIN read_markers r ON r.agent_id = mem.agent_id AND r.conversation_id = c.id
     LEFT JOIN prefs p ON p.agent_id = mem.agent_id AND p.conversation_id = c.id
     WHERE mem.agent_id = ?1 AND c.kind IN ('public', 'private') AND c.last_seq > r.last_read_seq
       AND COALESCE(p.muted, 0) = 0
     ORDER BY c.last_message_at DESC`,
    scope.agent.id,
  )
    .filter((row) => row.unread > 0)
    .map((row) => ({ channel: `#${row.slug}`, unread: row.unread }));
}

export function checkInbox(scope: Scope, args: { limit?: number; cursor?: string }) {
  const limit = Math.min(Math.max(args.limit ?? INBOX_PAGE_DEFAULT, 1), INBOX_PAGE_MAX);
  const [afterCreatedAt, afterMessageId] = decodeCursor(args.cursor);
  const rows = all<InboxRow>(
    scope.sql,
    `SELECT message_id, reason, created_at FROM inbox
     WHERE agent_id = ? AND read_at IS NULL AND (created_at > ? OR (created_at = ? AND message_id > ?))
     ORDER BY created_at, message_id LIMIT ?`,
    scope.agent.id,
    afterCreatedAt,
    afterCreatedAt,
    afterMessageId,
    limit + 1,
  );
  const page = rows.slice(0, limit);
  const items = page.map((row) => {
    const message = one<MessageRow>(scope.sql, "SELECT * FROM messages WHERE id = ?", row.message_id)!;
    const conversation = one<ConversationRow>(scope.sql, "SELECT * FROM conversations WHERE id = ?", message.conversation_id)!;
    return { reason: row.reason, conversation: label(conversation), message: viewMessage(scope, conversation, message) };
  });

  const countsByReason = new Map(
    all<{ reason: string; n: number }>(
      scope.sql,
      "SELECT reason, count(*) AS n FROM inbox WHERE agent_id = ? AND read_at IS NULL GROUP BY reason",
      scope.agent.id,
    ).map((row) => [row.reason, row.n]),
  );
  const counts = Object.fromEntries(
    REASONS_MOST_URGENT_FIRST.filter((reason) => countsByReason.has(reason)).map((reason) => [reason, countsByReason.get(reason)!]),
  );
  return {
    items,
    counts,
    unread_channels: unreadChannels(scope),
    next_cursor: rows.length > limit ? encodeCursor(page.at(-1)!) : null,
    ...(args.cursor ? {} : { brief: buildBrief(scope) }),
  };
}

export async function watchInbox(scope: Scope, args: { session?: string }, grantId: string) {
  const requestedSessionHash = args.session ? await sha256Hex(args.session) : null;
  if (requestedSessionHash && scope.agent.session_hash && requestedSessionHash !== scope.agent.session_hash) {
    throw new ToolError(nameInUseRefusal(scope.agent.handle, scope.agent.name));
  }
  const sessionHash = scope.agent.session_hash ? requestedSessionHash : null;
  const ticket = newStreamTicket();
  const ticketHash = await sha256Hex(ticket);
  run(scope.sql, "DELETE FROM stream_tickets WHERE expires_at <= ?", scope.now);
  run(
    scope.sql,
    "INSERT INTO stream_tickets (ticket_hash, agent_id, grant_id, expires_at, session_hash) VALUES (?, ?, ?, ?, ?)",
    ticketHash,
    scope.agent.id,
    grantId,
    scope.now + LIMITS.streamTicketMs,
    sessionHash,
  );
  run(
    scope.sql,
    `DELETE FROM stream_tickets WHERE agent_id = ?1 AND ticket_hash NOT IN (
       SELECT ticket_hash FROM stream_tickets WHERE agent_id = ?1 ORDER BY expires_at DESC, rowid DESC LIMIT ?2)`,
    scope.agent.id,
    LIMITS.liveStreamTicketsPerAgent,
  );
  const url = streamUrl(scope.env.PUBLIC_URL, scope.workspaceId);
  return {
    url,
    ticket,
    command: `BACKCHANNELS_TICKET=${ticket} npx backchannels@latest wait ${url}`,
    usage: "Run command as a background command with a 2 hour timeout; when it exits, call check_inbox, then run it again.",
  };
}

function latestSeq(scope: Scope, conversation: ConversationRow, rootId: number | null): number {
  const where = rootId ? "(id = ?1 OR thread_root_id = ?1)" : "conversation_id = ?1 AND (thread_root_id IS NULL OR also_in_channel = 1)";
  return one<{ seq: number | null }>(scope.sql, `SELECT max(seq) AS seq FROM messages WHERE ${where}`, rootId ?? conversation.id)?.seq ?? 0;
}

function markUnreadFrom(scope: Scope, conversation: ConversationRow, rootId: number | null, fromSeq: number): void {
  const markerSeq = fromSeq - 1;
  if (rootId) {
    run(
      scope.sql,
      `INSERT INTO thread_reads (agent_id, root_id, last_read_seq) VALUES (?, ?, ?)
       ON CONFLICT (agent_id, root_id) DO UPDATE SET last_read_seq = excluded.last_read_seq`,
      scope.agent.id,
      rootId,
      markerSeq,
    );
    run(
      scope.sql,
      "UPDATE inbox SET read_at = NULL WHERE agent_id = ? AND message_id IN (SELECT id FROM messages WHERE thread_root_id = ? AND seq >= ?)",
      scope.agent.id,
      rootId,
      fromSeq,
    );
    return;
  }
  if (isMember(scope, conversation.id)) {
    run(scope.sql, "UPDATE read_markers SET last_read_seq = ? WHERE agent_id = ? AND conversation_id = ?", markerSeq, scope.agent.id, conversation.id);
  }
  run(
    scope.sql,
    `UPDATE inbox SET read_at = NULL WHERE agent_id = ? AND message_id IN (
       SELECT id FROM messages WHERE conversation_id = ? AND seq >= ? AND (thread_root_id IS NULL OR also_in_channel = 1))`,
    scope.agent.id,
    conversation.id,
    fromSeq,
  );
}

function markEverythingRead(scope: Scope) {
  const behindMarker = `FROM read_markers r JOIN conversations c ON c.id = r.conversation_id
    WHERE r.agent_id = ? AND r.last_read_seq < c.last_seq`;
  const inboxItems = one<{ n: number }>(scope.sql, "SELECT count(*) AS n FROM inbox WHERE agent_id = ? AND read_at IS NULL", scope.agent.id)!.n;
  const conversations = one<{ n: number }>(scope.sql, `SELECT count(*) AS n ${behindMarker}`, scope.agent.id)!.n;
  run(scope.sql, "UPDATE inbox SET read_at = ? WHERE agent_id = ? AND read_at IS NULL", scope.now, scope.agent.id);
  run(
    scope.sql,
    `UPDATE read_markers SET last_read_seq = (SELECT last_seq FROM conversations c WHERE c.id = read_markers.conversation_id)
     WHERE agent_id = ?`,
    scope.agent.id,
  );
  return { marked_read: { inbox_items: inboxItems, conversations } };
}

function markInboxItemsRead(scope: Scope, messageIds: string[]) {
  const cleared: string[] = [];
  const notInInbox: string[] = [];
  for (const ref of messageIds) {
    const { conversation, message } = findMessage(scope, ref);
    const id = messageRef(conversation, message.seq);
    const updated = run(
      scope.sql,
      "UPDATE inbox SET read_at = ? WHERE agent_id = ? AND message_id = ? AND read_at IS NULL",
      scope.now,
      scope.agent.id,
      message.id,
    );
    (updated ? cleared : notInInbox).push(id);
  }
  return { marked_read: { messages: cleared }, not_in_inbox: notInInbox };
}

export function markRead(
  scope: Scope,
  args: { conversation?: string; up_to?: string; unread?: boolean; all?: boolean; messages?: string[] },
) {
  const modes = [args.conversation !== undefined, !!args.all, !!args.messages?.length].filter(Boolean).length;
  if (modes !== 1) throw new ToolError("pass exactly one of: conversation, all: true, or messages");
  if (args.all) return markEverythingRead(scope);
  if (args.messages?.length) return markInboxItemsRead(scope, args.messages);

  const { conversation, root } = conversationOrThread(scope, args.conversation!);
  const target = root ? `${messageRef(conversation, root.seq)}/t` : label(conversation);
  const upTo = seqOf(args.up_to);

  if (args.unread) {
    if (upTo === undefined) throw new ToolError("unread needs up_to: the first message ID to show as unread again");
    markUnreadFrom(scope, conversation, root?.id ?? null, upTo);
    return { conversation: target, unread_from: messageRef(conversation, upTo) };
  }
  const seq = upTo ?? latestSeq(scope, conversation, root?.id ?? null);
  if (seq > 0) {
    if (root) markThreadRead(scope, root.id, seq);
    else markConversationRead(scope, conversation.id, seq);
  }
  return { conversation: target, read_up_to: seq > 0 ? messageRef(conversation, seq) : null };
}

function viewDefaults(scope: Scope) {
  return {
    level: defaultLevel(scope, scope.agent.id),
    keywords: all<{ keyword: string }>(scope.sql, "SELECT keyword FROM keywords WHERE agent_id = ? ORDER BY keyword", scope.agent.id).map(
      (row) => row.keyword,
    ),
  };
}

function viewConversationPrefs(scope: Scope, conversation: ConversationRow) {
  const prefs = effectivePrefs(scope, scope.agent.id, conversation);
  return { conversation: label(conversation), level: prefs.level, inherited: prefs.inherited, muted: prefs.muted };
}

export function getNotificationPrefs(scope: Scope, args: { conversation?: string }) {
  if (!args.conversation) return viewDefaults(scope);
  return viewConversationPrefs(scope, findConversation(scope, args.conversation));
}

function normalizeKeywords(keywords: string[]): string[] {
  const normalized = [...new Set(keywords.map((keyword) => keyword.trim().toLowerCase()).filter(Boolean))];
  if (normalized.length > KEYWORD_LIMIT) throw new ToolError(`at most ${KEYWORD_LIMIT} keywords; you sent ${normalized.length}`);
  const tooLong = normalized.find((keyword) => keyword.length > KEYWORD_MAX_LENGTH);
  if (tooLong) throw new ToolError(`keyword '${tooLong.slice(0, 20)}…' is longer than ${KEYWORD_MAX_LENGTH} characters`);
  return normalized;
}

export function setNotificationPrefs(
  scope: Scope,
  args: { conversation?: string; level?: "all" | "mentions" | "nothing"; muted?: boolean; keywords?: string[] },
) {
  const agentId = scope.agent.id;
  if (!args.conversation) {
    if (args.muted !== undefined) throw new ToolError("muted applies to one conversation; pass conversation");
    if (args.level) {
      const updated = run(scope.sql, "UPDATE prefs SET level = ? WHERE agent_id = ? AND conversation_id IS NULL", args.level, agentId);
      if (!updated) run(scope.sql, "INSERT INTO prefs (agent_id, conversation_id, level) VALUES (?, NULL, ?)", agentId, args.level);
    }
    if (args.keywords) {
      const keywords = normalizeKeywords(args.keywords);
      run(scope.sql, "DELETE FROM keywords WHERE agent_id = ?", agentId);
      for (const keyword of keywords) run(scope.sql, "INSERT INTO keywords (agent_id, keyword) VALUES (?, ?)", agentId, keyword);
    }
    return viewDefaults(scope);
  }

  if (args.keywords) throw new ToolError("keywords apply to all conversations; call again without conversation to set them");
  const conversation = findConversation(scope, args.conversation);
  const current = one<{ level: string | null; muted: number }>(
    scope.sql,
    "SELECT level, muted FROM prefs WHERE agent_id = ? AND conversation_id = ?",
    agentId,
    conversation.id,
  );
  run(
    scope.sql,
    `INSERT INTO prefs (agent_id, conversation_id, level, muted) VALUES (?, ?, ?, ?)
     ON CONFLICT (agent_id, conversation_id) DO UPDATE SET level = excluded.level, muted = excluded.muted`,
    agentId,
    conversation.id,
    args.level ?? current?.level ?? null,
    args.muted === undefined ? (current?.muted ?? 0) : args.muted ? 1 : 0,
  );
  return viewConversationPrefs(scope, conversation);
}
