import { fileNamesOf } from "../files";
import { all, one, type ConversationRow, type MessageRow, type Scope } from "../store";
import { SEMANTIC } from "./config";

const DAY_MS = 24 * 60 * 60_000;

export type VectorKind = "msg" | "thread";

export type IndexJob =
  | { op: "upsert"; ws: string; conv: number; seq: number; kind: VectorKind; version: number }
  | { op: "delete"; ws: string; conv: number; seq: number; kind: VectorKind };

type WithoutWorkspace<T> = T extends unknown ? Omit<T, "ws"> : never;
export type WorkspaceIndexJob = WithoutWorkspace<IndexJob>;
export type PendingIndexJob = WorkspaceIndexJob & { delaySeconds?: number };

export interface VectorMetadata {
  vis: "pub" | "priv";
  kind: VectorKind;
  author: string;
  ch: number;
  day: number;
}

export type IndexDocument =
  | { action: "upsert"; id: string; text: string; metadata: VectorMetadata }
  | { action: "delete"; id: string };

export function vectorId(workspaceId: string, conversationId: number, seq: number, kind: VectorKind): string {
  return kind === "thread" ? `${workspaceId}:${conversationId}:${seq}:t` : `${workspaceId}:${conversationId}:${seq}`;
}

export function parseVectorId(id: string): { conversationId: number; seq: number; kind: VectorKind } | null {
  const match = /^ws_[a-z0-9]+:(\d+):(\d+)(:t)?$/.exec(id);
  if (!match) return null;
  return { conversationId: Number(match[1]), seq: Number(match[2]), kind: match[3] ? "thread" : "msg" };
}

export function queueMessageUpsert(scope: Scope, message: Pick<MessageRow, "conversation_id" | "seq">, version: number): void {
  scope.indexJobs.push({ op: "upsert", conv: message.conversation_id, seq: message.seq, kind: "msg", version });
}

export function queueThreadUpsert(scope: Scope, root: Pick<MessageRow, "conversation_id" | "seq">, threadVersion: number): void {
  scope.indexJobs.push({
    op: "upsert",
    conv: root.conversation_id,
    seq: root.seq,
    kind: "thread",
    version: threadVersion,
    delaySeconds: SEMANTIC.threadDelaySeconds,
  });
}

export function queueDelete(scope: Scope, message: Pick<MessageRow, "conversation_id" | "seq">, kind: VectorKind): void {
  scope.indexJobs.push({ op: "delete", conv: message.conversation_id, seq: message.seq, kind });
}

interface MessageWithVersions extends MessageRow {
  version: number;
  thread_version: number;
  word_count: number;
}

function conversationLabel(conversation: ConversationRow): string {
  return conversation.kind === "public" || conversation.kind === "private" ? `#${conversation.slug}` : "dm";
}

function handleOf(sql: SqlStorage, agentId: string): string {
  return one<{ handle: string }>(sql, "SELECT handle FROM agents WHERE id = ?", agentId)?.handle ?? "unknown";
}

function metadataFor(conversation: ConversationRow, message: MessageRow, kind: VectorKind): VectorMetadata {
  return {
    vis: conversation.kind === "public" ? "pub" : "priv",
    kind,
    author: message.author_id,
    ch: conversation.id,
    day: Math.floor(message.created_at / DAY_MS),
  };
}

function messageText(sql: SqlStorage, conversation: ConversationRow, message: MessageWithVersions): string {
  const parts = [conversationLabel(conversation)];
  if (message.thread_root_id) {
    const root = one<{ text: string }>(sql, "SELECT text FROM messages WHERE id = ?", message.thread_root_id);
    if (root) parts.push(`reply to: ${root.text.slice(0, SEMANTIC.rootContextChars)}`);
  }
  parts.push(`@${handleOf(sql, message.author_id)}: ${message.text}`);
  const fileNames = fileNamesOf(sql, message.id);
  if (fileNames.length) parts.push(`files: ${fileNames.join(", ")}`);
  if (message.word_count < SEMANTIC.shortMessageWords) {
    const previous = one<MessageRow>(
      sql,
      message.thread_root_id
        ? "SELECT * FROM messages WHERE (thread_root_id = ?1 OR id = ?1) AND seq < ?2 AND deleted_at IS NULL ORDER BY seq DESC LIMIT 1"
        : "SELECT * FROM messages WHERE conversation_id = ?1 AND thread_root_id IS NULL AND seq < ?2 AND deleted_at IS NULL ORDER BY seq DESC LIMIT 1",
      message.thread_root_id ?? message.conversation_id,
      message.seq,
    );
    if (previous) {
      parts.unshift(`previous: @${handleOf(sql, previous.author_id)}: ${previous.text.slice(0, SEMANTIC.previousContextChars)}`);
    }
  }
  return parts.join(" · ");
}

function threadText(sql: SqlStorage, conversation: ConversationRow, root: MessageRow): string {
  let text = `${conversationLabel(conversation)} · thread · @${handleOf(sql, root.author_id)}: ${root.text}`.slice(0, SEMANTIC.threadTextMaxChars);
  if (text.length === SEMANTIC.threadTextMaxChars) return text;
  const replies = sql.exec<{ text: string; handle: string | null }>(
    `SELECT m.text, a.handle FROM messages m LEFT JOIN agents a ON a.id = m.author_id
     WHERE m.thread_root_id = ? AND m.deleted_at IS NULL ORDER BY m.seq`,
    root.id,
  );
  for (const reply of replies) {
    const post = `\n@${reply.handle ?? "unknown"}: ${reply.text}`;
    text += post.slice(0, SEMANTIC.threadTextMaxChars - text.length);
    if (text.length === SEMANTIC.threadTextMaxChars) break;
  }
  return text;
}

export function buildDocument(sql: SqlStorage, workspaceId: string, job: IndexJob): IndexDocument | null {
  const id = vectorId(workspaceId, job.conv, job.seq, job.kind);
  if (job.op === "delete") return { action: "delete", id };
  const conversation = one<ConversationRow>(sql, "SELECT * FROM conversations WHERE id = ?", job.conv);
  const message = one<MessageWithVersions>(sql, "SELECT * FROM messages WHERE conversation_id = ? AND seq = ?", job.conv, job.seq);
  if (!conversation || !message || message.deleted_at) return null;
  const currentVersion = job.kind === "thread" ? message.thread_version : message.version;
  if (currentVersion > job.version) return null;
  if (job.kind === "thread" && message.reply_count === 0) return { action: "delete", id };
  const text = job.kind === "thread" ? threadText(sql, conversation, message) : messageText(sql, conversation, message);
  return { action: "upsert", id, text, metadata: metadataFor(conversation, message, job.kind) };
}

export function reindexJobs(sql: SqlStorage, afterMessageId: number, limit: number): { jobs: WorkspaceIndexJob[]; lastId: number | null } {
  const messages = all<MessageWithVersions>(sql, "SELECT * FROM messages WHERE id > ? ORDER BY id LIMIT ?", afterMessageId, limit);
  const jobs = messages.flatMap((message): WorkspaceIndexJob[] => {
    const position = { conv: message.conversation_id, seq: message.seq };
    const isThreadRoot = !message.thread_root_id && message.reply_count > 0;
    if (message.deleted_at) {
      const deleteOwn: WorkspaceIndexJob = { op: "delete", ...position, kind: "msg" };
      return isThreadRoot ? [deleteOwn, { op: "delete", ...position, kind: "thread" }] : [deleteOwn];
    }
    const upsertOwn: WorkspaceIndexJob = { op: "upsert", ...position, kind: "msg", version: message.version };
    return isThreadRoot ? [upsertOwn, { op: "upsert", ...position, kind: "thread", version: message.thread_version }] : [upsertOwn];
  });
  return { jobs, lastId: messages.at(-1)?.id ?? null };
}
