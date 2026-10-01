import type { AdminReadOptions, AdminResult, AdminSearchOptions, AttachedFile, ConversationPage, ReadPosition, AdminSearchPage, Conversation, ConversationSort, DirectoryKind, Message, Reaction, Scope, SearchMatch, SearchSort } from "./admin";
import { matchOffsets, searchAsViewer, type Searcher, type ViewerSearch } from "./search";
import { DEFAULT_CHANNELS } from "./defaultChannels";
import { SEARCH } from "./search/config";
import { parseQuery, type FreeTerm } from "./search/query";
import { ToolError, all, one, run, type AgentRow, type ConversationRow, type MessageRow, type Scope as ToolScope } from "./store";

const LIST_PAGE_SIZE = 100;
const SEARCH_PAGE_SIZE = 50;
const DEFAULT_READ_LIMIT = 100;
const MAX_READ_LIMIT = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

const invalid = { ok: false, error: "invalid" } as const;
const notFound = { ok: false, error: "not_found" } as const;

export interface AdminContext {
  sql: SqlStorage;
  now: number;
  sub: string;
  audit: (tool: string, conversationId?: number) => void;
  searchScope: (agent: AgentRow) => ToolScope;
  readStateChanged?: () => void;
}

type ListedRow = ConversationRow & {
  display_name: string;
  display_topic: string;
  messages_today: number;
  people: number;
  is_mine: number;
  pin_count: number;
  read_marker: number | null;
  last_read_seq_effective: number;
  unread: number;
};
type AuthoredMessageRow = MessageRow & {
  handle: string | null;
  owner_email: string | null;
  owner_sub: string | null;
  live_replies: number;
  last_live_reply_at: number | null;
  thread_root_seq: number | null;
  pinned_at: number | null;
  pinned_by: string | null;
};

const SCOPES: readonly Scope[] = ["mine", "everyone"];
const KINDS: readonly DirectoryKind[] = ["public", "private"];
const SEARCH_SORTS: readonly SearchSort[] = ["relevant", "recent"];
const SORT_ORDER: Record<ConversationSort, string> = {
  active: "messages_today DESC, last_message_at IS NULL, last_message_at DESC",
  recent: "last_message_at IS NULL, last_message_at DESC",
  name: "display_name COLLATE NOCASE",
};

const MEMBER_HANDLES = `SELECT a.handle FROM members m JOIN agents a ON a.id = m.agent_id WHERE m.conversation_id = ? ORDER BY a.handle`;
const ownConversations = (subParameter: string) => `own_conversations AS (
  SELECT DISTINCT mb.conversation_id FROM members mb JOIN agents own ON own.id = mb.agent_id
  WHERE own.owner_sub = ${subParameter} AND own.revoked_at IS NULL)`;
const SEQ_BEFORE_FIRST_VISIT = (conversationColumn: string) =>
  `(SELECT max(before.seq) FROM messages before WHERE before.conversation_id = ${conversationColumn}
     AND before.created_at <= (SELECT first_seen_at FROM viewers WHERE owner_sub = ?2))`;
const UNREAD_MESSAGE = (subParameter: string) =>
  `m.deleted_at IS NULL AND m.author_id NOT IN (SELECT id FROM agents WHERE owner_sub = ${subParameter})`;
const LIVE_REPLIES = `(SELECT count(*) FROM messages reply WHERE reply.thread_root_id = m.id AND reply.deleted_at IS NULL)`;
const LAST_LIVE_REPLY_AT = `(SELECT max(reply.created_at) FROM messages reply WHERE reply.thread_root_id = m.id AND reply.deleted_at IS NULL)`;
const MESSAGE_COLUMNS = `m.*, a.handle, a.owner_email, a.owner_sub, ${LIVE_REPLIES} AS live_replies, ${LAST_LIVE_REPLY_AT} AS last_live_reply_at,
  (SELECT root.seq FROM messages root WHERE root.id = m.thread_root_id) AS thread_root_seq,
  pin.pinned_at, (SELECT pinner.handle FROM agents pinner WHERE pinner.id = pin.pinned_by) AS pinned_by`;
const MESSAGE_JOINS = `LEFT JOIN agents a ON a.id = m.author_id LEFT JOIN pins pin ON pin.message_id = m.id`;
const MESSAGE_SELECT = `SELECT ${MESSAGE_COLUMNS} FROM messages m ${MESSAGE_JOINS}`;

function rememberViewer(context: AdminContext): void {
  if (run(context.sql, "INSERT OR IGNORE INTO viewers (owner_sub, first_seen_at) VALUES (?, ?)", context.sub, context.now)) {
    context.readStateChanged?.();
  }
}

function listedConversations(context: AdminContext, condition: string, conversationCondition: string, ...bindings: (string | number)[]): ListedRow[] {
  rememberViewer(context);
  return all<ListedRow>(
    context.sql,
    `WITH ${ownConversations("?2")},
     listed AS (
       SELECT c.*,
         CASE WHEN c.kind IN ('public', 'private') THEN '#' || c.slug
           ELSE coalesce((SELECT group_concat(a.handle, ', ' ORDER BY a.handle) FROM members m JOIN agents a ON a.id = m.agent_id WHERE m.conversation_id = c.id), c.slug)
         END AS display_name,
         CASE WHEN c.kind NOT IN ('public', 'private') THEN '' WHEN c.topic <> '' THEN c.topic ELSE c.purpose END AS display_topic,
         (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id AND m.deleted_at IS NULL AND m.created_at > ?1) AS messages_today,
         (SELECT count(DISTINCT a.owner_sub) FROM members m JOIN agents a ON a.id = m.agent_id WHERE m.conversation_id = c.id) AS people,
         (SELECT count(*) FROM pins p JOIN messages pm ON pm.id = p.message_id WHERE pm.conversation_id = c.id AND pm.deleted_at IS NULL) AS pin_count,
         c.id IN (SELECT conversation_id FROM own_conversations) AS is_mine,
         (SELECT vr.last_read_seq FROM viewer_reads vr WHERE vr.owner_sub = ?2 AND vr.conversation_id = c.id) AS read_marker
       FROM conversations c WHERE c.archived_at IS NULL AND ${conversationCondition}
     ),
     marked AS (
       SELECT listed.*, coalesce(read_marker, ${SEQ_BEFORE_FIRST_VISIT("listed.id")}, 0) AS last_read_seq_effective FROM listed
     )
     SELECT marked.*,
       CASE WHEN is_mine = 1 OR read_marker IS NOT NULL
         THEN (SELECT count(*) FROM messages m WHERE m.conversation_id = marked.id AND m.seq > marked.last_read_seq_effective
           AND ${UNREAD_MESSAGE("?2")} AND (m.thread_root_id IS NULL OR m.also_in_channel = 1))
         ELSE 0 END AS unread
     FROM marked WHERE (kind = 'public' OR is_mine = 1) AND ${condition}`,
    context.now - DAY_MS,
    context.sub,
    ...bindings,
  );
}

function viewConversation(context: AdminContext, row: ListedRow): Conversation {
  const members = row.kind === "public" ? [] : all<{ handle: string }>(context.sql, MEMBER_HANDLES, row.id);
  const latest = all<{ handle: string | null; text: string }>(
    context.sql,
    `SELECT a.handle, m.text FROM messages m LEFT JOIN agents a ON a.id = m.author_id
     WHERE m.conversation_id = ? AND m.deleted_at IS NULL ORDER BY m.seq DESC LIMIT 1`,
    row.id,
  )[0];
  return {
    id: row.slug,
    name: row.display_name,
    kind: row.kind,
    isPrivate: row.kind !== "public",
    isDefault: row.kind === "public" && defaultChannelSlugs.has(row.slug),
    topic: row.display_topic,
    members: members.map((member) => member.handle),
    people: row.people,
    messagesToday: row.messages_today,
    lastActivity: row.last_message_at === null ? null : new Date(row.last_message_at).toISOString(),
    isMine: row.is_mine === 1,
    pins: row.pin_count,
    unread: row.unread,
    lastReadSeq: row.last_read_seq_effective,
    preview: latest ? `${latest.handle ?? "unknown"}: ${latest.text}` : row.display_topic,
  };
}

function reactionsByMessageId(context: AdminContext, rows: AuthoredMessageRow[]): Map<number, Reaction[]> {
  const reactedIds = rows.filter((row) => row.reaction_count > 0 && !row.deleted_at).map((row) => row.id);
  const reactionsById = new Map<number, Reaction[]>();
  if (reactedIds.length === 0) return reactionsById;
  const reactionRows = all<{ message_id: number; emoji: string; handle: string }>(
    context.sql,
    `SELECT r.message_id, r.emoji, a.handle FROM reactions r JOIN agents a ON a.id = r.agent_id
     WHERE r.message_id IN (SELECT value FROM json_each(?)) ORDER BY r.created_at`,
    JSON.stringify(reactedIds),
  );
  for (const { message_id, emoji, handle } of reactionRows) {
    const reactions = reactionsById.get(message_id) ?? [];
    reactionsById.set(message_id, reactions);
    const existing = reactions.find((reaction) => reaction.emoji === emoji);
    if (existing) {
      existing.agents.push(handle);
      continue;
    }
    reactions.push({ emoji, agents: [handle] });
  }
  return reactionsById;
}

function filesByMessageId(context: AdminContext, rows: AuthoredMessageRow[]): Map<number, AttachedFile[]> {
  const idsWithFiles = rows.filter((row) => row.has_file && !row.deleted_at).map((row) => row.id);
  const filesById = new Map<number, AttachedFile[]>();
  if (idsWithFiles.length === 0) return filesById;
  const fileRows = all<AttachedFile & { message_id: number }>(
    context.sql,
    `SELECT message_id, id, name, mime, size FROM files
     WHERE message_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, id`,
    JSON.stringify(idsWithFiles),
  );
  for (const { message_id, ...file } of fileRows) filesById.set(message_id, [...(filesById.get(message_id) ?? []), file]);
  return filesById;
}

function unreadRepliesByRootId(context: AdminContext, rows: AuthoredMessageRow[], channelLastReadSeq: number): Map<number, number> {
  const rootIds = rows.filter((row) => row.thread_root_id === null && row.live_replies > 0).map((row) => row.id);
  if (rootIds.length === 0) return new Map();
  const counts = all<{ root_id: number; unread: number }>(
    context.sql,
    `SELECT m.thread_root_id AS root_id, count(*) AS unread FROM messages m
     LEFT JOIN viewer_thread_reads tr ON tr.owner_sub = ?1 AND tr.root_id = m.thread_root_id
     WHERE m.thread_root_id IN (SELECT value FROM json_each(?2)) AND m.seq > coalesce(tr.last_read_seq, ?3) AND ${UNREAD_MESSAGE("?1")}
     GROUP BY m.thread_root_id`,
    context.sub,
    JSON.stringify(rootIds),
    channelLastReadSeq,
  );
  return new Map(counts.map((count) => [count.root_id, count.unread]));
}

function viewMessages<Row extends AuthoredMessageRow>(context: AdminContext, rows: Row[], unreadReplies: Map<number, number> = new Map()): Message[] {
  const reactionsById = reactionsByMessageId(context, rows);
  const filesById = filesByMessageId(context, rows);
  return rows.map((row) => ({
    ...viewMessage(row, context.sub, reactionsById.get(row.id) ?? [], filesById.get(row.id) ?? []),
    unreadReplies: unreadReplies.get(row.id) ?? 0,
  }));
}

const defaultChannelSlugs = new Set(DEFAULT_CHANNELS.map((channel) => channel.name));
const isoTime = (epochMs: number | null) => (epochMs === null ? null : new Date(epochMs).toISOString());
const agentName = (handle: string) => handle.slice(handle.indexOf("/") + 1);

function viewMessage(row: AuthoredMessageRow, sub: string, reactions: Reaction[], files: AttachedFile[]): Omit<Message, "unreadReplies"> {
  const email = row.owner_email ?? "";
  const handle = row.handle ?? "unknown";
  return {
    seq: row.seq,
    person: email.split("@")[0],
    personEmail: email,
    agent: agentName(handle),
    handle,
    time: new Date(row.created_at).toISOString(),
    text: row.deleted_at ? "" : row.text,
    isOwn: row.owner_sub === sub,
    threadReplies: row.live_replies,
    lastReplyAt: isoTime(row.last_live_reply_at),
    threadRootSeq: row.thread_root_seq,
    alsoInChannel: row.also_in_channel === 1,
    editedAt: isoTime(row.edited_at),
    deleted: row.deleted_at !== null,
    pinned: row.pinned_at === null ? null : { by: row.pinned_by ?? "unknown", at: isoTime(row.pinned_at)! },
    reactions,
    files,
  };
}

function parseOffset(cursor: unknown): number | null {
  if (cursor === undefined) return 0;
  if (typeof cursor !== "string" || !/^\d{1,9}$/.test(cursor)) return null;
  return Number(cursor);
}

const isOneOf = <Value extends string>(allowed: readonly Value[], value: unknown): value is Value =>
  allowed.includes(value as Value);

export function adminList(
  context: AdminContext,
  options: { scope: Scope; kind?: DirectoryKind; sort?: ConversationSort; filter?: string; cursor?: string },
): AdminResult<{ conversations: Conversation[]; totals: { public: number; publicMine: number; private: number }; nextCursor?: string }> {
  const sort = options?.sort ?? "active";
  const offset = parseOffset(options?.cursor);
  if (!isOneOf(SCOPES, options?.scope) || !isOneOf(Object.keys(SORT_ORDER) as ConversationSort[], sort)) return invalid;
  if (options.kind !== undefined && !isOneOf(KINDS, options.kind)) return invalid;
  if (options.filter !== undefined && typeof options.filter !== "string") return invalid;
  if (offset === null) return invalid;

  context.audit("admin_list");
  const rows = listedConversations(
    context,
    `(?3 = 0 OR is_mine = 1)
     AND (?4 = '' OR (?4 = 'public') = (kind = 'public'))
     AND (?5 = '' OR instr(lower(display_name || ' ' || display_topic), ?5) > 0)
     ORDER BY ${SORT_ORDER[sort]}, id LIMIT ?6 OFFSET ?7`,
    "1",
    options.scope === "mine" ? 1 : 0,
    options.kind ?? "",
    options.filter?.trim().toLowerCase() ?? "",
    LIST_PAGE_SIZE + 1,
    offset,
  );
  const totals = all<{ public: number | null; public_mine: number | null; private: number | null }>(
    context.sql,
    `WITH ${ownConversations("?1")}
     SELECT sum(kind = 'public') AS public,
       sum(kind = 'public' AND id IN (SELECT conversation_id FROM own_conversations)) AS public_mine,
       sum(kind <> 'public' AND id IN (SELECT conversation_id FROM own_conversations)) AS private
     FROM conversations WHERE archived_at IS NULL`,
    context.sub,
  )[0];
  const page = rows.slice(0, LIST_PAGE_SIZE);
  return {
    ok: true,
    value: {
      conversations: page.map((row) => viewConversation(context, row)),
      totals: { public: totals?.public ?? 0, publicMine: totals?.public_mine ?? 0, private: totals?.private ?? 0 },
      ...(rows.length > LIST_PAGE_SIZE ? { nextCursor: String(offset + LIST_PAGE_SIZE) } : {}),
    },
  };
}

const isPositiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

function findReadable(context: AdminContext, conversation: unknown): ListedRow | undefined {
  if (typeof conversation !== "string") return undefined;
  return listedConversations(context, "1", "c.slug = ?3", conversation)[0];
}

type StreamPage = { rows: AuthoredMessageRow[]; hasOlder: boolean; hasNewer: boolean };

function readStream(context: AdminContext, scopeCondition: string, scopeId: number, position: ReadPosition, limit: number): StreamPage {
  const streamSelect = (comparison: string, order: "ASC" | "DESC") => (pivot: number, count: number) =>
    all<AuthoredMessageRow>(
      context.sql,
      `${MESSAGE_SELECT}
       WHERE ${scopeCondition} AND (m.deleted_at IS NULL OR live_replies > 0) AND m.seq ${comparison} ?2
       ORDER BY m.seq ${order} LIMIT ?3`,
      scopeId,
      pivot,
      count,
    );
  const olderThan = streamSelect("<", "DESC");
  const newerThan = streamSelect(">", "ASC");
  const atOrNewer = streamSelect(">=", "ASC");

  if (position.after !== undefined) {
    const newer = newerThan(position.after, limit + 1);
    return { rows: newer.slice(0, limit), hasOlder: true, hasNewer: newer.length > limit };
  }
  if (position.around !== undefined) {
    const olderCount = Math.floor(limit / 2);
    const older = olderThan(position.around, olderCount + 1);
    const newer = atOrNewer(position.around, limit - olderCount + 1);
    return {
      rows: [...older.slice(0, olderCount).reverse(), ...newer.slice(0, limit - olderCount)],
      hasOlder: older.length > olderCount,
      hasNewer: newer.length > limit - olderCount,
    };
  }
  const older = olderThan(position.before ?? Number.MAX_SAFE_INTEGER, limit + 1);
  const page = older.slice(0, limit).reverse();
  const hasNewer = position.before !== undefined && page.length > 0 && newerThan(page.at(-1)!.seq, 1).length > 0;
  return { rows: page, hasOlder: older.length > limit, hasNewer };
}

export function adminRead(context: AdminContext, options: AdminReadOptions): AdminResult<ConversationPage> {
  const positions = [options?.before, options?.after, options?.around].filter((value) => value !== undefined);
  if (typeof options?.conversation !== "string" || positions.length > 1) return invalid;
  if (options.thread !== undefined && !isPositiveInteger(options.thread)) return invalid;
  if (!positions.every(isPositiveInteger)) return invalid;
  if (options.limit !== undefined && !isPositiveInteger(options.limit)) return invalid;
  const limit = Math.min(options.limit ?? DEFAULT_READ_LIMIT, MAX_READ_LIMIT);

  const row = findReadable(context, options.conversation);
  if (!row) return notFound;
  const threadRoot =
    options.thread === undefined
      ? null
      : one<{ id: number }>(
          context.sql,
          `SELECT m.id FROM messages m WHERE m.conversation_id = ? AND m.seq = ? AND m.thread_root_id IS NULL
             AND (m.deleted_at IS NULL OR ${LIVE_REPLIES} > 0)`,
          row.id,
          options.thread,
        );
  if (options.thread !== undefined && !threadRoot) return notFound;
  context.audit("admin_read", row.id);
  const scopeCondition = threadRoot
    ? "(m.id = ?1 OR m.thread_root_id = ?1)"
    : "m.conversation_id = ?1 AND (m.thread_root_id IS NULL OR m.also_in_channel = 1)";
  const scopeId = threadRoot?.id ?? row.id;
  const lastReadSeq = threadRoot ? threadLastReadSeq(context, threadRoot.id, row.last_read_seq_effective) : row.last_read_seq_effective;
  const firstUnreadSeq = firstUnreadInStream(context, scopeCondition, scopeId, lastReadSeq);
  const opensAtFirstUnread = positions.length === 0 && firstUnreadSeq !== null && streamCountFrom(context, scopeCondition, scopeId, firstUnreadSeq) > limit;
  const position: ReadPosition = opensAtFirstUnread ? { around: firstUnreadSeq } : options;
  const { rows, hasOlder, hasNewer } = readStream(context, scopeCondition, scopeId, position, limit);
  const unreadReplies = threadRoot ? new Map<number, number>() : unreadRepliesByRootId(context, rows, row.last_read_seq_effective);
  return {
    ok: true,
    value: {
      conversation: viewConversation(context, row),
      messages: viewMessages(context, rows, unreadReplies),
      lastReadSeq,
      ...(firstUnreadSeq !== null ? { firstUnreadSeq } : {}),
      ...(hasOlder && rows.length ? { nextBefore: rows[0].seq } : {}),
      ...(hasNewer && rows.length ? { nextAfter: rows.at(-1)!.seq } : {}),
    },
  };
}

function threadLastReadSeq(context: AdminContext, rootId: number, channelLastReadSeq: number): number {
  const marker = one<{ last_read_seq: number }>(
    context.sql,
    "SELECT last_read_seq FROM viewer_thread_reads WHERE owner_sub = ? AND root_id = ?",
    context.sub,
    rootId,
  );
  return marker?.last_read_seq ?? channelLastReadSeq;
}

function firstUnreadInStream(context: AdminContext, scopeCondition: string, scopeId: number, lastReadSeq: number): number | null {
  const first = one<{ seq: number | null }>(
    context.sql,
    `SELECT min(m.seq) AS seq FROM messages m WHERE ${scopeCondition} AND m.seq > ?2 AND ${UNREAD_MESSAGE("?3")}`,
    scopeId,
    lastReadSeq,
    context.sub,
  );
  return first?.seq ?? null;
}

function streamCountFrom(context: AdminContext, scopeCondition: string, scopeId: number, fromSeq: number): number {
  return (
    one<{ n: number }>(context.sql, `SELECT count(*) AS n FROM messages m WHERE ${scopeCondition} AND m.seq >= ?2 AND m.deleted_at IS NULL`, scopeId, fromSeq)?.n ??
    0
  );
}

export function adminMarkRead(context: AdminContext, options: { conversation: string; thread?: number; upToSeq: number }): AdminResult<{ unread: number }> {
  if (!isPositiveInteger(options?.upToSeq) || (options.thread !== undefined && !isPositiveInteger(options.thread))) return invalid;
  const row = findReadable(context, options.conversation);
  if (!row) return notFound;
  const upToSeq = Math.min(options.upToSeq, row.last_seq);
  if (options.thread === undefined) {
    const changed = run(
      context.sql,
      `INSERT INTO viewer_reads (owner_sub, conversation_id, last_read_seq, updated_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (owner_sub, conversation_id) DO UPDATE SET last_read_seq = excluded.last_read_seq, updated_at = excluded.updated_at
       WHERE excluded.last_read_seq > viewer_reads.last_read_seq`,
      context.sub,
      row.id,
      upToSeq,
      context.now,
    );
    if (changed) context.readStateChanged?.();
    const unread = one<{ count: number }>(
      context.sql,
      `SELECT count(*) AS count FROM messages m WHERE m.conversation_id = ?1 AND m.seq > ?2
         AND ${UNREAD_MESSAGE("?3")} AND (m.thread_root_id IS NULL OR m.also_in_channel = 1)`,
      row.id,
      Math.max(row.read_marker ?? upToSeq, upToSeq),
      context.sub,
    )!.count;
    return { ok: true, value: { unread } };
  }
  const root = one<{ id: number }>(
    context.sql,
    "SELECT id FROM messages WHERE conversation_id = ? AND seq = ? AND thread_root_id IS NULL",
    row.id,
    options.thread,
  );
  if (!root) return notFound;
  const changed = run(
    context.sql,
    `INSERT INTO viewer_thread_reads (owner_sub, root_id, last_read_seq, updated_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (owner_sub, root_id) DO UPDATE SET last_read_seq = excluded.last_read_seq, updated_at = excluded.updated_at
     WHERE excluded.last_read_seq > viewer_thread_reads.last_read_seq`,
    context.sub,
    root.id,
    upToSeq,
    context.now,
  );
  if (changed) context.readStateChanged?.();
  return { ok: true, value: { unread: row.unread } };
}

export function adminPins(context: AdminContext, options: { conversation: string }): AdminResult<{ conversation: Conversation; messages: Message[] }> {
  const row = findReadable(context, options?.conversation);
  if (!row) return notFound;
  context.audit("admin_pins", row.id);
  const rows = all<AuthoredMessageRow>(
    context.sql,
    `${MESSAGE_SELECT} WHERE m.conversation_id = ? AND pin.message_id IS NOT NULL AND m.deleted_at IS NULL
     ORDER BY pin.pinned_at DESC LIMIT ?`,
    row.id,
    MAX_READ_LIMIT,
  );
  return { ok: true, value: { conversation: viewConversation(context, row), messages: viewMessages(context, rows) } };
}

export function adminFile(context: AdminContext, options: { conversation: string; file: string }): AdminResult<{ name: string; mime: string; r2Key: string }> {
  const row = findReadable(context, options?.conversation);
  if (!row || typeof options.file !== "string") return notFound;
  const file = one<{ name: string; mime: string; r2_key: string }>(
    context.sql,
    `SELECT f.name, f.mime, f.r2_key FROM files f JOIN messages m ON m.id = f.message_id
     WHERE f.id = ? AND m.conversation_id = ? AND m.deleted_at IS NULL`,
    options.file,
    row.id,
  );
  if (!file) return notFound;
  context.audit("admin_file", row.id);
  return { ok: true, value: { name: file.name, mime: file.mime, r2Key: file.r2_key } };
}

const ADMIN_SEARCH_LOG_PREFIX = "admin:";

type SearchedRow = AuthoredMessageRow & { conversation_slug: string; conversation_kind: ConversationRow["kind"] };

function ownAgents(context: AdminContext): AgentRow[] {
  return all<AgentRow>(
    context.sql,
    "SELECT * FROM agents WHERE owner_sub = ? AND revoked_at IS NULL ORDER BY last_active_at DESC",
    context.sub,
  );
}

function viewerAgent(context: AdminContext, agents: AgentRow[]): AgentRow {
  return (
    agents[0] ?? {
      id: `${ADMIN_SEARCH_LOG_PREFIX}${context.sub}`,
      handle: "",
      name: "",
      description: "",
      owner_sub: context.sub,
      owner_email: "",
      owner_name: "",
      created_at: context.now,
      last_active_at: context.now,
      revoked_at: null,
    }
  );
}

function ownConversationIds(context: AdminContext): number[] {
  return all<{ conversation_id: number }>(
    context.sql,
    `WITH ${ownConversations("?")} SELECT conversation_id FROM own_conversations`,
    context.sub,
  ).map((row) => row.conversation_id);
}

function searchMatches(context: AdminContext, ids: number[], terms: FreeTerm[]): SearchMatch[] {
  if (!ids.length) return [];
  const rows = all<SearchedRow>(
    context.sql,
    `SELECT ${MESSAGE_COLUMNS}, c.slug AS conversation_slug, c.kind AS conversation_kind
     FROM json_each(?1) j JOIN messages m ON m.id = j.value
       JOIN conversations c ON c.id = m.conversation_id
       ${MESSAGE_JOINS}
     WHERE m.deleted_at IS NULL
     ORDER BY j.key`,
    JSON.stringify(ids),
  );
  const namesByConversationId = new Map<number, string>();
  const conversationName = (row: SearchedRow) => {
    if (row.conversation_kind === "public" || row.conversation_kind === "private") return `#${row.conversation_slug}`;
    const cached = namesByConversationId.get(row.conversation_id);
    if (cached) return cached;
    const handles = all<{ handle: string }>(context.sql, MEMBER_HANDLES, row.conversation_id).map((member) => member.handle);
    const name = handles.join(", ") || row.conversation_slug;
    namesByConversationId.set(row.conversation_id, name);
    return name;
  };
  const messages = viewMessages(context, rows);
  return rows.map((row, index) => ({
    conversation: { id: row.conversation_slug, name: conversationName(row), isPrivate: row.conversation_kind !== "public" },
    message: messages[index],
    ranges: matchOffsets(row.text, terms),
  }));
}

function parseSearchCursor(cursor: string): { searchId: number; offset: number } | null {
  const match = /^s(\d{1,12})\.(\d{1,9})$/.exec(cursor);
  return match ? { searchId: Number(match[1]), offset: Number(match[2]) } : null;
}

function searchPage(context: AdminContext, searchId: number, ordered: number[], terms: FreeTerm[], offset: number) {
  const nextOffset = offset + SEARCH_PAGE_SIZE;
  return {
    matches: searchMatches(context, ordered.slice(offset, nextOffset), terms),
    ...(nextOffset < ordered.length ? { nextCursor: `s${searchId}.${nextOffset}` } : {}),
  };
}

export async function adminSearch(context: AdminContext, options: AdminSearchOptions): Promise<AdminResult<AdminSearchPage>> {
  const sort = options?.sort ?? "relevant";
  if (typeof options?.query !== "string" || !isOneOf(SCOPES, options.scope) || !isOneOf(SEARCH_SORTS, sort)) return invalid;
  if (options.cursor !== undefined && typeof options.cursor !== "string") return invalid;
  const logOwner = `${ADMIN_SEARCH_LOG_PREFIX}${context.sub}`;

  if (options.cursor !== undefined) {
    const cursor = parseSearchCursor(options.cursor);
    if (!cursor) return invalid;
    const log = one<{ query: string; results: string; created_at: number }>(
      context.sql,
      "SELECT query, results, created_at FROM search_log WHERE id = ? AND agent_id = ?",
      cursor.searchId,
      logOwner,
    );
    if (!log || context.now - log.created_at > SEARCH.cursorTtlMs) {
      return { ok: true, value: { matches: [], problem: "These results expired after 10 minutes. Search again to see more." } };
    }
    context.audit("admin_search");
    return { ok: true, value: searchPage(context, cursor.searchId, JSON.parse(log.results), parseQuery(log.query).include, cursor.offset) };
  }

  const agents = ownAgents(context);
  const scope = context.searchScope(viewerAgent(context, agents));
  const ownIds = ownConversationIds(context);
  const privateIds = all<{ id: number }>(
    context.sql,
    "SELECT id FROM conversations WHERE kind <> 'public' AND archived_at IS NULL AND id IN (SELECT value FROM json_each(?))",
    JSON.stringify(ownIds),
  ).map((row) => row.id);
  const searcher: Searcher = {
    privateIds,
    selfIds: agents.map((agent) => agent.id),
    hideArchived: true,
    ...(options.scope === "mine" ? { onlyIn: ownIds } : {}),
  };
  let searched: ViewerSearch;
  try {
    searched = await searchAsViewer(scope, searcher, options.query, sort);
  } catch (error) {
    if (error instanceof ToolError) return { ok: true, value: { matches: [], problem: error.message } };
    throw error;
  }
  context.audit("admin_search");
  const searchId = one<{ id: number }>(
    context.sql,
    "INSERT INTO search_log (agent_id, query, sort, results, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
    logOwner,
    options.query.trim(),
    sort,
    JSON.stringify(searched.ordered),
    context.now,
  )!.id;
  const firstPage = searchPage(context, searchId, searched.ordered, searched.terms, 0);
  const top = searched.top ? searchMatches(context, searched.top, searched.terms) : undefined;
  return { ok: true, value: { ...firstPage, ...(top?.length ? { top } : {}) } };
}
