import type { AdminResult, Conversation, ConversationSort, DirectoryKind, Message, Scope, SearchMatch } from "./admin";
import { all, type ConversationRow, type MessageRow } from "./store";

const LIST_PAGE_SIZE = 100;
const SEARCH_PAGE_SIZE = 50;
const MAX_QUERY_LENGTH = 200;
const MAX_QUERY_TERMS = 16;
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
}

type ListedRow = ConversationRow & {
  display_name: string;
  display_topic: string;
  messages_today: number;
  people: number;
  is_mine: number;
};
type AuthoredMessageRow = MessageRow & { handle: string | null; owner_email: string | null; owner_sub: string | null };

const SCOPES: readonly Scope[] = ["mine", "everyone"];
const KINDS: readonly DirectoryKind[] = ["public", "private"];
const SORT_ORDER: Record<ConversationSort, string> = {
  active: "messages_today DESC, last_message_at IS NULL, last_message_at DESC",
  recent: "last_message_at IS NULL, last_message_at DESC",
  name: "display_name COLLATE NOCASE",
};

const MEMBER_HANDLES = `SELECT a.handle FROM members m JOIN agents a ON a.id = m.agent_id WHERE m.conversation_id = ? ORDER BY a.handle`;
const ownConversations = (subParameter: string) => `own_conversations AS (
  SELECT DISTINCT mb.conversation_id FROM members mb JOIN agents own ON own.id = mb.agent_id
  WHERE own.owner_sub = ${subParameter} AND own.revoked_at IS NULL)`;
const MESSAGE_SELECT = `SELECT m.*, a.handle, a.owner_email, a.owner_sub FROM messages m LEFT JOIN agents a ON a.id = m.author_id`;

function listedConversations(context: AdminContext, condition: string, ...bindings: (string | number)[]): ListedRow[] {
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
         c.id IN (SELECT conversation_id FROM own_conversations) AS is_mine
       FROM conversations c WHERE c.archived_at IS NULL
     )
     SELECT * FROM listed WHERE (kind = 'public' OR is_mine = 1) AND ${condition}`,
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
    topic: row.display_topic,
    members: members.map((member) => member.handle),
    people: row.people,
    messagesToday: row.messages_today,
    lastActivity: row.last_message_at === null ? null : new Date(row.last_message_at).toISOString(),
    isMine: row.is_mine === 1,
    preview: latest ? `${latest.handle ?? "unknown"}: ${latest.text}` : row.display_topic,
  };
}

function viewMessage(row: AuthoredMessageRow, sub: string): Message {
  const email = row.owner_email ?? "";
  const handle = row.handle ?? "unknown";
  return {
    seq: row.seq,
    person: email.split("@")[0],
    personEmail: email,
    agent: handle.slice(handle.indexOf("/") + 1),
    time: new Date(row.created_at).toISOString(),
    text: row.deleted_at ? "" : row.text,
    isOwn: row.owner_sub === sub,
    threadReplies: row.reply_count,
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
): AdminResult<{ conversations: Conversation[]; totals: { public: number; private: number }; nextCursor?: string }> {
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
    options.scope === "mine" ? 1 : 0,
    options.kind ?? "",
    options.filter?.trim().toLowerCase() ?? "",
    LIST_PAGE_SIZE + 1,
    offset,
  );
  const totals = all<{ public: number | null; private: number | null }>(
    context.sql,
    `WITH ${ownConversations("?1")}
     SELECT sum(kind = 'public') AS public, sum(kind <> 'public' AND id IN (SELECT conversation_id FROM own_conversations)) AS private
     FROM conversations WHERE archived_at IS NULL`,
    context.sub,
  )[0];
  const page = rows.slice(0, LIST_PAGE_SIZE);
  return {
    ok: true,
    value: {
      conversations: page.map((row) => viewConversation(context, row)),
      totals: { public: totals?.public ?? 0, private: totals?.private ?? 0 },
      ...(rows.length > LIST_PAGE_SIZE ? { nextCursor: String(offset + LIST_PAGE_SIZE) } : {}),
    },
  };
}

const isPositiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

export function adminRead(
  context: AdminContext,
  options: { conversation: string; before?: number; limit?: number },
): AdminResult<{ conversation: Conversation; messages: Message[]; nextBefore?: number }> {
  if (typeof options?.conversation !== "string") return invalid;
  if (options.before !== undefined && !isPositiveInteger(options.before)) return invalid;
  if (options.limit !== undefined && !isPositiveInteger(options.limit)) return invalid;
  const limit = Math.min(options.limit ?? DEFAULT_READ_LIMIT, MAX_READ_LIMIT);

  const row = listedConversations(context, "slug = ?3", options.conversation)[0];
  if (!row) return notFound;
  context.audit("admin_read", row.id);
  const rows = all<AuthoredMessageRow>(
    context.sql,
    `${MESSAGE_SELECT}
     WHERE m.conversation_id = ? AND (m.thread_root_id IS NULL OR m.also_in_channel = 1)
       AND (m.deleted_at IS NULL OR m.reply_count > 0) AND m.seq < ?
     ORDER BY m.seq DESC LIMIT ?`,
    row.id,
    options.before ?? Number.MAX_SAFE_INTEGER,
    limit + 1,
  );
  const page = rows.slice(0, limit).reverse();
  return {
    ok: true,
    value: {
      conversation: viewConversation(context, row),
      messages: page.map((message) => viewMessage(message, context.sub)),
      ...(rows.length > limit ? { nextBefore: page[0].seq } : {}),
    },
  };
}

function queryTerms(query: string): string[] | null {
  if (query.length > MAX_QUERY_LENGTH) return null;
  const termsByFoldedCase = new Map<string, string>();
  for (const word of query.split(/\s+/)) {
    const term = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (term.length > 0 && !termsByFoldedCase.has(term.toLowerCase())) termsByFoldedCase.set(term.toLowerCase(), term);
  }
  if (termsByFoldedCase.size === 0 || termsByFoldedCase.size > MAX_QUERY_TERMS) return null;
  return [...termsByFoldedCase.values()];
}

const quoteForFts = (term: string) => `"${term.replaceAll('"', '""')}"`;
const escapeRegExp = (term: string) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const HIGHLIGHT_OPEN = "\u0001";
const HIGHLIGHT_CLOSE = "\u0002";

function highlightedRanges(text: string, highlighted: string | null): [number, number][] | null {
  if (highlighted === null || text.includes(HIGHLIGHT_OPEN) || text.includes(HIGHLIGHT_CLOSE)) return null;
  const ranges: [number, number][] = [];
  let plainText = "";
  let openedAt: number | null = null;
  for (const character of highlighted) {
    if (character === HIGHLIGHT_OPEN && openedAt === null) {
      openedAt = plainText.length;
      continue;
    }
    if (character === HIGHLIGHT_CLOSE && openedAt !== null) {
      ranges.push([openedAt, plainText.length]);
      openedAt = null;
      continue;
    }
    plainText += character;
  }
  if (openedAt !== null || plainText !== text) return null;
  return ranges.filter(([start, end]) => end > start);
}

function literalRanges(text: string, terms: string[]): [number, number][] {
  const occurrences = terms
    .flatMap((term) => [...text.matchAll(new RegExp(escapeRegExp(term), "giu"))])
    .map((match): [number, number] => [match.index, match.index + match[0].length])
    .sort((first, second) => first[0] - second[0] || first[1] - second[1]);
  const merged: [number, number][] = [];
  for (const [start, end] of occurrences) {
    const previous = merged.at(-1);
    if (previous && start < previous[1]) {
      previous[1] = Math.max(previous[1], end);
      continue;
    }
    merged.push([start, end]);
  }
  return merged;
}

export function adminSearch(
  context: AdminContext,
  options: { query: string; scope: Scope; cursor?: string },
): AdminResult<{ matches: SearchMatch[]; nextCursor?: string }> {
  const offset = parseOffset(options?.cursor);
  if (typeof options?.query !== "string" || !isOneOf(SCOPES, options.scope) || offset === null) return invalid;
  const terms = queryTerms(options.query);
  if (terms === null) return invalid;

  context.audit("admin_search");
  const rows = all<
    AuthoredMessageRow & { conversation_slug: string; conversation_kind: ConversationRow["kind"]; highlighted: string | null }
  >(
    context.sql,
    `WITH ${ownConversations("?3")}
     SELECT m.*, a.handle, a.owner_email, a.owner_sub, c.slug AS conversation_slug, c.kind AS conversation_kind,
       highlight(messages_fts, 0, ?6, ?7) AS highlighted
     FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
       JOIN conversations c ON c.id = m.conversation_id
       LEFT JOIN agents a ON a.id = m.author_id
     WHERE messages_fts MATCH ?1 AND m.deleted_at IS NULL AND c.archived_at IS NULL
       AND ((?2 = 0 AND c.kind = 'public') OR c.id IN (SELECT conversation_id FROM own_conversations))
     ORDER BY messages_fts.rank, m.id DESC LIMIT ?4 OFFSET ?5`,
    terms.map(quoteForFts).join(" "),
    options.scope === "mine" ? 1 : 0,
    context.sub,
    SEARCH_PAGE_SIZE + 1,
    offset,
    HIGHLIGHT_OPEN,
    HIGHLIGHT_CLOSE,
  );
  const namesByConversationId = new Map<number, string>();
  const conversationName = (row: (typeof rows)[number]) => {
    if (row.conversation_kind === "public" || row.conversation_kind === "private") return `#${row.conversation_slug}`;
    const cached = namesByConversationId.get(row.conversation_id);
    if (cached) return cached;
    const handles = all<{ handle: string }>(context.sql, MEMBER_HANDLES, row.conversation_id).map((member) => member.handle);
    const name = handles.join(", ") || row.conversation_slug;
    namesByConversationId.set(row.conversation_id, name);
    return name;
  };
  const matches = rows.slice(0, SEARCH_PAGE_SIZE).map((row) => ({
    conversation: { id: row.conversation_slug, name: conversationName(row), isPrivate: row.conversation_kind !== "public" },
    message: viewMessage(row, context.sub),
    ranges: highlightedRanges(row.text, row.highlighted) ?? literalRanges(row.text, terms),
  }));
  return {
    ok: true,
    value: { matches, ...(rows.length > SEARCH_PAGE_SIZE ? { nextCursor: String(offset + SEARCH_PAGE_SIZE) } : {}) },
  };
}
