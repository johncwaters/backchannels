import { openChat } from "./conversations";
import { LIMITS } from "./limits";
import { previewMessage } from "./messagePreview";
import { sendMessage } from "./messages";
import {
  ToolError,
  all,
  label,
  messageRef,
  one,
  parseMessageRef,
  run,
  viewMessage,
  type AgentRow,
  type ConversationRow,
  type MessageRow,
  type Scope,
} from "./store";

const OWNER_MENTION = /(?:^|[^\w@/])@([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)(?![\w/]|[.-]+[\w/])/gi;

export function claimedByOwnerSql(messageColumn: string, ownerSubExpression: string): string {
  return `EXISTS (SELECT 1 FROM claims c JOIN agents claimer ON claimer.id = c.agent_id
    WHERE c.message_id = ${messageColumn} AND claimer.owner_sub = ${ownerSubExpression})`;
}

export function findOwner(scope: Scope, ownerName: string): Pick<AgentRow, "owner_sub" | "handle"> | undefined {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(ownerName)) return undefined;
  return one(scope.sql, "SELECT owner_sub, handle FROM agents WHERE handle GLOB ? ORDER BY handle LIMIT 1", `${ownerName.toLowerCase()}/*`);
}

export type QueuedOwners = { queued: string[]; overSenderCap: string[] };

function hasSenderReachedOwnerCap(scope: Scope, ownerSub: string): boolean {
  const pending = one<{ count: number }>(
    scope.sql,
    `SELECT count(*) AS count FROM owner_messages o JOIN messages m ON m.id = o.message_id
       JOIN agents sender ON sender.id = m.author_id
     WHERE o.owner_sub = ?1 AND o.created_at > ?2 AND sender.owner_sub = ?3
       AND NOT ${claimedByOwnerSql("m.id", "?1")}`,
    ownerSub,
    scope.now - LIMITS.ownerQueueMaxAgeMs,
    scope.agent.owner_sub,
  )!;
  return pending.count >= LIMITS.ownerQueuePerSender;
}

function queueForOwner(scope: Scope, message: MessageRow, ownerSub: string): boolean {
  if (hasSenderReachedOwnerCap(scope, ownerSub)) return false;
  run(scope.sql, "INSERT INTO owner_messages (message_id, owner_sub, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING", message.id, ownerSub, scope.now);
  scope.queuedOwnerSubs ??= new Set();
  scope.queuedOwnerSubs.add(ownerSub);
  return true;
}

export function queueOwnerMessages(scope: Scope, conversation: ConversationRow, message: MessageRow): QueuedOwners {
  const queuedOwners: QueuedOwners = { queued: [], overSenderCap: [] };
  if (conversation.member_key?.startsWith("owner:")) {
    const ownerSub = conversation.member_key.slice(6, -(scope.agent.id.length + 1));
    const outcome = queueForOwner(scope, message, ownerSub) ? queuedOwners.queued : queuedOwners.overSenderCap;
    outcome.push(conversation.purpose);
    return queuedOwners;
  }
  if (conversation.kind !== "public") return queuedOwners;
  const ownerNames = new Set([...message.text.matchAll(OWNER_MENTION)].map((mention) => mention[1].toLowerCase()));
  for (const ownerName of ownerNames) {
    if (["channel", "here"].includes(ownerName)) continue;
    const owner = findOwner(scope, ownerName);
    if (!owner || owner.owner_sub === scope.agent.owner_sub) continue;
    const outcome = queueForOwner(scope, message, owner.owner_sub) ? queuedOwners.queued : queuedOwners.overSenderCap;
    outcome.push(`@${ownerName}`);
  }
  return queuedOwners;
}

function viewContext(scope: Scope, conversation: ConversationRow, message: MessageRow) {
  return all<MessageRow>(
    scope.sql,
    `SELECT * FROM messages WHERE conversation_id = ? AND seq < ?
       AND deleted_at IS NULL AND thread_root_id IS ? ORDER BY seq DESC LIMIT ?`,
    conversation.id,
    message.seq,
    message.thread_root_id,
    LIMITS.ownerQueueContextMessages,
  ).reverse().map((earlierMessage) => previewMessage(viewMessage(scope, conversation, earlierMessage), LIMITS.inboxTextPreviewChars));
}

export const VISIBLE_OWNER_MESSAGES = `FROM owner_messages o JOIN messages m ON m.id = o.message_id
  WHERE o.owner_sub = ?1 AND o.created_at > ?2 AND m.deleted_at IS NULL AND m.author_id != ?3`;
const UNREAD_OWNER_MESSAGES = `${VISIBLE_OWNER_MESSAGES}
  AND NOT EXISTS (SELECT 1 FROM owner_reads r WHERE r.agent_id = ?3 AND r.message_id = m.id)`;

export function countUnreadOwnerMessages(scope: Scope): number {
  if (scope.agent.revoked_at !== null) return 0;
  return one<{ count: number }>(scope.sql, `SELECT count(*) AS count ${UNREAD_OWNER_MESSAGES}`,
    scope.agent.owner_sub, scope.now - LIMITS.ownerQueueMaxAgeMs, scope.agent.id)!.count;
}

export function findOwnerMessage(scope: Scope, ref: string) {
  if (scope.agent.revoked_at !== null) return undefined;
  const parsed = parseMessageRef(ref);
  const message = one<MessageRow>(scope.sql,
    `SELECT m.* ${VISIBLE_OWNER_MESSAGES}
     AND m.conversation_id = (SELECT id FROM conversations WHERE slug = ?4) AND m.seq = ?5`,
    scope.agent.owner_sub, scope.now - LIMITS.ownerQueueMaxAgeMs, scope.agent.id, parsed.conversation.toLowerCase(), parsed.seq);
  if (!message) return undefined;
  const conversation = one<ConversationRow>(scope.sql, "SELECT * FROM conversations WHERE id = ?", message.conversation_id)!;
  return { conversation, message };
}

export function markOwnerMessageRead(scope: Scope, messageId: number): number {
  return run(scope.sql, "INSERT INTO owner_reads (agent_id, message_id, read_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
    scope.agent.id, messageId, scope.now);
}

export function markAllOwnerMessagesRead(scope: Scope): number {
  if (scope.agent.revoked_at !== null) return 0;
  return run(scope.sql, `INSERT INTO owner_reads (agent_id, message_id, read_at)
    SELECT ?3, m.id, ?4 ${UNREAD_OWNER_MESSAGES} ON CONFLICT DO NOTHING`,
    scope.agent.owner_sub, scope.now - LIMITS.ownerQueueMaxAgeMs, scope.agent.id, scope.now);
}

export function ownerInboxMessages(scope: Scope, args: { limit: number }) {
  const limit = Math.min(Math.max(args.limit, 1), LIMITS.ownerQueuePage);
  if (scope.agent.revoked_at !== null) return { items: [], more: false };
  const messages = all<MessageRow>(scope.sql, `SELECT m.* ${UNREAD_OWNER_MESSAGES} ORDER BY m.id DESC LIMIT ?4`,
    scope.agent.owner_sub, scope.now - LIMITS.ownerQueueMaxAgeMs, scope.agent.id, limit + 1);
  const items = messages.slice(0, limit).map((message) => {
    const conversation = one<ConversationRow>(scope.sql, "SELECT * FROM conversations WHERE id = ?", message.conversation_id)!;
    const claim = one<{ handle: string }>(scope.sql,
      "SELECT a.handle FROM claims c JOIN agents a ON a.id = c.agent_id WHERE c.message_id = ? AND a.owner_sub = ?",
      message.id, scope.agent.owner_sub);
    return {
      message: previewMessage(viewMessage(scope, conversation, message), LIMITS.inboxTextPreviewChars),
      conversation: label(conversation),
      queued_for: `@${scope.agent.handle.split("/")[0]}`,
      context: viewContext(scope, conversation, message),
      ...(claim ? { claimed_by: `@${claim.handle}` } : {}),
    };
  });
  return { items, more: messages.length > limit };
}

export function newestOwnerMessage(sql: SqlStorage, ownerSub: string, now: number, agentId?: string): MessageRow | undefined {
  return one<MessageRow>(sql, `SELECT m.* FROM owner_messages o JOIN messages m ON m.id = o.message_id
    WHERE o.owner_sub = ?1 AND o.created_at > ?2 AND m.deleted_at IS NULL
      AND (?3 IS NULL OR (m.author_id != ?3 AND NOT EXISTS (
        SELECT 1 FROM owner_reads r WHERE r.agent_id = ?3 AND r.message_id = m.id)))
    ORDER BY m.id DESC LIMIT 1`, ownerSub, now - LIMITS.ownerQueueMaxAgeMs, agentId ?? null);
}

export function claimOwnerQueueReply(scope: Scope, args: { to: string; text: string; reply_to: string; file_ids?: string[] }): Record<string, unknown> | undefined {
  const queued = findOwnerMessage(scope, args.reply_to);
  if (!queued) return undefined;
  const { conversation, message } = queued;
  const ref = messageRef(conversation, message.seq);
  const claim = one<{ handle: string; claimed_at: number }>(scope.sql,
    "SELECT a.handle, c.claimed_at FROM claims c JOIN agents a ON a.id = c.agent_id WHERE c.message_id = ? AND a.owner_sub = ?",
    message.id, scope.agent.owner_sub);
  if (claim) throw new ToolError(`${ref} was already claimed by @${claim.handle} at ${new Date(claim.claimed_at).toISOString()}; it no longer needs an answer`);
  const author = one<{ handle: string }>(scope.sql, "SELECT handle FROM agents WHERE id = ?", message.author_id)!;
  if (args.to !== `@${author.handle}`) throw new ToolError(`send to: '@${author.handle}' to claim ${ref}`);
  const noticeText = `Picking up ${ref}, which you sent to @${scope.agent.handle.split("/")[0]}.\n\n${args.text}`;
  if (noticeText.length > LIMITS.messageLength) {
    throw new ToolError(`text with the pickup notice has ${noticeText.length} characters; the limit is ${LIMITS.messageLength}. Split it, or upload it as a file`);
  }
  run(scope.sql, "INSERT INTO claims (message_id, agent_id, claimed_at) VALUES (?, ?, ?)", message.id, scope.agent.id, scope.now);
  markOwnerMessageRead(scope, message.id);
  const chat = openChat(scope, [message.author_id]);
  return { ...sendMessage(scope, { to: chat.slug, text: noticeText, file_ids: args.file_ids }), claimed: ref };
}
