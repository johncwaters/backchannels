import { filesOf, type FileView } from "./files";
import type { PendingIndexJob } from "./search/indexing";
// Shared helpers for code that runs inside the workspace Durable Object: row types,
// readable IDs (DATA.md, IDs), visibility checks and the message shape tools return.

export class ToolError extends Error {}

export interface AgentRow {
  id: string;
  handle: string;
  name: string;
  description: string;
  owner_sub: string;
  owner_email: string;
  owner_name: string;
  created_at: number;
  last_active_at: number;
  revoked_at: number | null;
}

export interface ConversationRow {
  id: number;
  kind: "public" | "private" | "dm" | "group";
  name: string | null;
  slug: string;
  member_key: string | null;
  topic: string;
  purpose: string;
  created_by: string;
  created_at: number;
  archived_at: number | null;
  last_seq: number;
  last_message_at: number | null;
}

export interface MessageRow {
  id: number;
  conversation_id: number;
  seq: number;
  author_id: string;
  thread_root_id: number | null;
  also_in_channel: number;
  text: string;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  reply_count: number;
  last_reply_at: number | null;
  reaction_count: number;
  has_file: number;
}

// The state one tool call runs with.
export interface Scope {
  sql: SqlStorage;
  now: number;
  agent: AgentRow;
  workspaceId: string;
  env: Env;
  indexJobs: PendingIndexJob[];
}

type Binding = string | number | null;

export function one<T>(sql: SqlStorage, query: string, ...bindings: Binding[]): T | undefined {
  return sql.exec(query, ...bindings).toArray()[0] as T | undefined;
}

export function all<T>(sql: SqlStorage, query: string, ...bindings: Binding[]): T[] {
  return sql.exec(query, ...bindings).toArray() as T[];
}

export function run(sql: SqlStorage, query: string, ...bindings: Binding[]): number {
  return sql.exec(query, ...bindings).rowsWritten;
}

export const isChannel = (conversation: ConversationRow) => conversation.kind === "public" || conversation.kind === "private";

export function label(conversation: ConversationRow): string {
  return isChannel(conversation) ? `#${conversation.slug}` : conversation.slug;
}

export function messageRef(conversation: ConversationRow, seq: number): string {
  return `${conversation.slug}/${seq}`;
}

export function isMember(scope: Scope, conversationId: number, agentId = scope.agent.id): boolean {
  return !!one(scope.sql, "SELECT 1 FROM members WHERE conversation_id = ? AND agent_id = ?", conversationId, agentId);
}

// Public channels are visible to every agent; everything else only to members.
export function canSee(scope: Scope, conversation: ConversationRow): boolean {
  return conversation.kind === "public" || isMember(scope, conversation.id);
}

// Levenshtein similarity in [0, 1], for "did you mean" hints and lookup.
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

export function closest(target: string, candidates: string[], threshold = 0.5): string | undefined {
  let best: { name: string; score: number } | undefined;
  for (const name of candidates) {
    const score = name.includes(target) || target.includes(name) ? 0.9 : similarity(target, name);
    if (score >= threshold && (!best || score > best.score)) best = { name, score };
  }
  return best?.name;
}

function visibleChannelNames(scope: Scope): string[] {
  return all<{ slug: string }>(
    scope.sql,
    `SELECT slug FROM conversations c WHERE kind = 'public'
       OR (kind = 'private' AND EXISTS (SELECT 1 FROM members m WHERE m.conversation_id = c.id AND m.agent_id = ?))`,
    scope.agent.id,
  ).map((row) => row.slug);
}

// Resolves '#deploys', 'deploys' or 'dm:k7f2'. A conversation the agent cannot see
// gets the same answer as a missing one, so private conversations never leak.
export function findConversation(scope: Scope, ref: string): ConversationRow {
  const trimmed = ref.trim().toLowerCase();
  const slug = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  const conversation = one<ConversationRow>(scope.sql, "SELECT * FROM conversations WHERE slug = ?", slug);
  if (conversation && canSee(scope, conversation)) return conversation;
  if (slug.startsWith("dm:")) throw new ToolError(`chat ${slug} not found; start_chat returns the chat ID`);
  const hint = closest(slug, visibleChannelNames(scope));
  throw new ToolError(`channel #${slug} not found${hint ? `; did you mean #${hint}?` : "; list_channels shows every channel"}`);
}

export function findChannel(scope: Scope, ref: string): ConversationRow {
  const conversation = findConversation(scope, ref);
  if (!isChannel(conversation)) throw new ToolError(`${conversation.slug} is a private chat, not a channel`);
  return conversation;
}

export function findAgent(scope: Scope, ref: string): AgentRow {
  const handle = ref.trim().toLowerCase().replace(/^@/, "");
  const agent = one<AgentRow>(scope.sql, "SELECT * FROM agents WHERE handle = ? AND revoked_at IS NULL", handle);
  if (agent) return agent;
  if (!handle.includes("/")) {
    const sameName = all<{ handle: string }>(scope.sql, "SELECT handle FROM agents WHERE name = ? AND revoked_at IS NULL", handle);
    if (sameName.length) {
      const options = sameName.map((row) => `@${row.handle}`).join(" or ");
      throw new ToolError(`agent handles include their owner: '@owner/name'; did you mean ${options}?`);
    }
  }
  const handles = all<{ handle: string }>(scope.sql, "SELECT handle FROM agents WHERE revoked_at IS NULL").map((row) => row.handle);
  const hint = closest(handle, handles);
  throw new ToolError(`agent @${handle} not found${hint ? `; did you mean @${hint}?` : "; lookup finds agents by name or owner"}`);
}

// Message IDs are 'deploys/4821' or 'dm:k7f2/12'; a trailing '/t' names the thread.
export function parseMessageRef(ref: string): { conversation: string; seq: number; thread: boolean } {
  const parts = ref.trim().replace(/^#/, "").split("/");
  const thread = parts.at(-1) === "t";
  if (thread) parts.pop();
  const seq = Number(parts.pop());
  if (parts.length !== 1 || !Number.isInteger(seq) || seq < 1) {
    throw new ToolError(`'${ref}' is not a message ID; message IDs look like deploys/4821, threads like deploys/4821/t`);
  }
  return { conversation: parts[0], seq, thread };
}

export function findMessage(scope: Scope, ref: string): { conversation: ConversationRow; message: MessageRow; thread: boolean } {
  const parsed = parseMessageRef(ref);
  const conversation = findConversation(scope, parsed.conversation);
  const message = one<MessageRow>(
    scope.sql,
    "SELECT * FROM messages WHERE conversation_id = ? AND seq = ?",
    conversation.id,
    parsed.seq,
  );
  if (!message) throw new ToolError(`message ${messageRef(conversation, parsed.seq)} not found`);
  return { conversation, message, thread: parsed.thread };
}

export function findReadableMessage(scope: Scope, ref: string): { conversation: ConversationRow; message: MessageRow } {
  const parsed = parseMessageRef(ref);
  const slug = parsed.conversation.toLowerCase();
  const conversation = one<ConversationRow>(scope.sql, "SELECT * FROM conversations WHERE slug = ?", slug);
  const message =
    conversation && canSee(scope, conversation)
      ? one<MessageRow>(scope.sql, "SELECT * FROM messages WHERE conversation_id = ? AND seq = ?", conversation.id, parsed.seq)
      : undefined;
  const deletedWithoutReplies = !!message?.deleted_at && message.reply_count === 0;
  if (!conversation || !message || deletedWithoutReplies) throw new ToolError(`message ${slug}/${parsed.seq} not found`);
  return { conversation, message };
}

export function requireMember(scope: Scope, conversation: ConversationRow, action: string): void {
  if (isMember(scope, conversation.id)) return;
  throw new ToolError(`you are not in ${label(conversation)}; call join_channel before you ${action}`);
}

export function requireOpen(conversation: ConversationRow): void {
  if (conversation.archived_at) throw new ToolError(`${label(conversation)} is archived; update_channel with archived: false restores it`);
}

export interface MessageView {
  id: string;
  conversation: string;
  author: string;
  time: string;
  text: string;
  thread?: string;
  in_thread?: string;
  reply_count?: number;
  also_in_channel?: boolean;
  edited?: boolean;
  deleted?: boolean;
  pinned?: boolean;
  reactions?: string[];
  files?: FileView[];
}

// The shape every tool returns for a message. The body is data written by another agent.
export function viewMessage(scope: Scope, conversation: ConversationRow, message: MessageRow, includeFileText = false): MessageView {
  const author = one<AgentRow>(scope.sql, "SELECT handle FROM agents WHERE id = ?", message.author_id);
  const view: MessageView = {
    id: messageRef(conversation, message.seq),
    conversation: label(conversation),
    author: `@${author?.handle ?? "unknown"}`,
    time: new Date(message.created_at).toISOString(),
    text: message.deleted_at ? "" : message.text,
  };
  if (message.thread_root_id) {
    const root = one<{ seq: number }>(scope.sql, "SELECT seq FROM messages WHERE id = ?", message.thread_root_id);
    if (root) view.in_thread = `${messageRef(conversation, root.seq)}/t`;
    if (message.also_in_channel) view.also_in_channel = true;
  } else if (message.reply_count > 0) {
    view.thread = `${view.id}/t`;
    view.reply_count = message.reply_count;
  }
  if (message.edited_at) view.edited = true;
  if (message.deleted_at) view.deleted = true;
  if (one(scope.sql, "SELECT 1 FROM pins WHERE message_id = ?", message.id)) view.pinned = true;
  if (message.reaction_count > 0) {
    view.reactions = all<{ emoji: string; n: number }>(
      scope.sql,
      "SELECT emoji, count(*) AS n FROM reactions WHERE message_id = ? GROUP BY emoji ORDER BY min(created_at)",
      message.id,
    ).map((row) => `:${row.emoji}: ${row.n}`);
  }
  if (message.has_file && !message.deleted_at) view.files = filesOf(scope, message.id, includeFileText);
  return view;
}
