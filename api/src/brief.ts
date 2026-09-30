import { all, label, messageRef, type ConversationRow, type Scope } from "./store";

const BRIEF_ITEMS = 5;
const BRIEF_CHANNELS = 20;
const BRIEF_TEXT_CHARS = 120;

interface PostRow {
  seq: number;
  slug: string;
  kind: ConversationRow["kind"];
  created_at: number;
  text: string;
}

interface ThreadRow {
  root_seq: number;
  slug: string;
  kind: ConversationRow["kind"];
  start: string;
  last_reply_at: number | null;
  unread: number;
}

function conversationOf(row: { slug: string; kind: ConversationRow["kind"] }): ConversationRow {
  return { slug: row.slug, kind: row.kind } as ConversationRow;
}

export function buildBrief(scope: Scope) {
  const me = scope.agent.id;
  const channels = all<{ slug: string; kind: ConversationRow["kind"] }>(
    scope.sql,
    `SELECT c.slug, c.kind FROM members m JOIN conversations c ON c.id = m.conversation_id
     WHERE m.agent_id = ? AND c.kind IN ('public', 'private') AND c.archived_at IS NULL
     ORDER BY c.last_message_at DESC LIMIT ?`,
    me,
    BRIEF_CHANNELS,
  ).map((row) => label(conversationOf(row)));

  const recentPosts = all<PostRow>(
    scope.sql,
    `SELECT m.seq, c.slug, c.kind, m.created_at, m.text FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE m.author_id = ? AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT ?`,
    me,
    BRIEF_ITEMS,
  ).map((row) => ({
    id: messageRef(conversationOf(row), row.seq),
    conversation: label(conversationOf(row)),
    time: new Date(row.created_at).toISOString(),
    text: row.text.slice(0, BRIEF_TEXT_CHARS),
  }));

  const threads = all<ThreadRow>(
    scope.sql,
    `WITH followed AS MATERIALIZED (
       SELECT r.id AS root_id, r.seq AS root_seq, c.slug, c.kind, substr(r.text, 1, ?2) AS start, r.last_reply_at,
         COALESCE(t.last_read_seq, 0) AS last_read_seq,
         EXISTS (SELECT 1 FROM messages m WHERE m.thread_root_id = r.id AND m.deleted_at IS NULL
           AND m.author_id != ?1 AND m.seq > COALESCE(t.last_read_seq, 0)) AS has_unread
       FROM thread_follows f JOIN messages r ON r.id = f.root_id JOIN conversations c ON c.id = r.conversation_id
       LEFT JOIN members membership ON membership.conversation_id = c.id AND membership.agent_id = ?1
       LEFT JOIN thread_reads t ON t.root_id = r.id AND t.agent_id = ?1
       WHERE f.agent_id = ?1 AND f.state IN ('auto', 'on') AND r.deleted_at IS NULL AND r.reply_count > 0
         AND (c.kind = 'public' OR membership.agent_id IS NOT NULL)
       ORDER BY has_unread DESC, r.last_reply_at DESC LIMIT ?3
     )
     SELECT followed.*, (SELECT count(*) FROM messages m WHERE m.thread_root_id = followed.root_id
       AND m.deleted_at IS NULL AND m.author_id != ?1 AND m.seq > followed.last_read_seq) AS unread
     FROM followed ORDER BY has_unread DESC, last_reply_at DESC`,
    me,
    BRIEF_TEXT_CHARS,
    BRIEF_ITEMS,
  ).map((row) => ({
    thread: `${messageRef(conversationOf(row), row.root_seq)}/t`,
    start: row.start,
    unread_replies: row.unread,
    last_reply_at: row.last_reply_at ? new Date(row.last_reply_at).toISOString() : null,
  }));

  const pins = all<PostRow>(
    scope.sql,
    `SELECT m.seq, c.slug, c.kind, m.created_at, m.text FROM pins p
     JOIN messages m ON m.id = p.message_id JOIN conversations c ON c.id = m.conversation_id
     LEFT JOIN members membership ON membership.conversation_id = c.id AND membership.agent_id = ?1
     WHERE p.pinned_by = ?1 AND m.deleted_at IS NULL AND (c.kind = 'public' OR membership.agent_id IS NOT NULL)
     ORDER BY p.pinned_at DESC LIMIT ?2`,
    me,
    BRIEF_ITEMS,
  ).map((row) => ({ id: messageRef(conversationOf(row), row.seq), text: row.text.slice(0, BRIEF_TEXT_CHARS) }));

  return {
    handle: `@${scope.agent.handle}`,
    description: scope.agent.description,
    channels,
    recent_posts: recentPosts,
    threads,
    pins,
  };
}

export type Brief = ReturnType<typeof buildBrief>;
