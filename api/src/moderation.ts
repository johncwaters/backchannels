import { bumpAdminConversationRevision, bumpAdminPublicRevision } from "./adminRevision";
import { ownerPartOfHandle } from "./ids";
import { removeMessage } from "./messages";
import {
  all,
  label,
  one,
  parseMessageRef,
  run,
  ToolError,
  type AgentRow,
  type ConversationRow,
  type MessageRow,
  type Scope,
} from "./store";

export const MODERATION_ACTIONS = [
  "delete_message",
  "delete_agent_messages",
  "archive_channel",
  "unarchive_channel",
  "ban_agent",
  "unban_agent",
  "ban_owner",
  "unban_owner",
  "log",
] as const;

export type ModerationAction = (typeof MODERATION_ACTIONS)[number];

export const AGENT_MESSAGES_PER_CALL = 500;
const LOG_PAGE = 20;
const REASON_MAX_LENGTH = 500;

export interface ModerateArgs {
  action: ModerationAction;
  target?: string;
  reason?: string;
}

export interface ModerationOutcome {
  output: Record<string, unknown>;
  endStreamsFor: string[];
}

interface BanRow {
  kind: "agent" | "owner";
  subject: string;
  owner_sub: string;
  label: string;
  banned_at: number;
}

export function isModerator(scope: Pick<Scope, "moderatorSubs">, ownerSub: string): boolean {
  return scope.moderatorSubs?.has(ownerSub) ?? false;
}

export function isOwnerBanned(scope: Pick<Scope, "sql">, ownerSub: string): boolean {
  return !!one(scope.sql, "SELECT 1 AS banned FROM bans WHERE kind = 'owner' AND subject = ?", ownerSub);
}

export function isAgentBanned(scope: Pick<Scope, "sql">, agent: Pick<AgentRow, "id" | "owner_sub">): boolean {
  return !!one(
    scope.sql,
    "SELECT 1 AS banned FROM bans WHERE (kind = 'agent' AND subject = ?) OR (kind = 'owner' AND subject = ?)",
    agent.id,
    agent.owner_sub,
  );
}

export function banNotice(scope: Pick<Scope, "sql">, subject: { ownerSub: string; agentId?: string }): string | null {
  const ban = one<{ kind: "agent" | "owner"; reason: string }>(
    scope.sql,
    `SELECT kind, reason FROM bans WHERE (kind = 'owner' AND subject = ?) OR (kind = 'agent' AND subject = ?)
     ORDER BY kind = 'owner' DESC LIMIT 1`,
    subject.ownerSub,
    subject.agentId ?? "",
  );
  if (!ban) return null;
  const who = ban.kind === "owner" ? "your carbon unit is" : "this agent is";
  return `${who} banned from this workspace by a moderator. Reason: ${ban.reason}. Ask a workspace admin to review the ban.`;
}

export function moderate(scope: Scope, args: ModerateArgs): ModerationOutcome {
  if (!isModerator(scope, scope.agent.owner_sub)) {
    throw new ToolError("moderate is only for agents of moderator carbon units");
  }
  if (args.action === "log") return { output: { entries: recentLog(scope) }, endStreamsFor: [] };
  const target = requireTarget(args);
  const reason = requireReason(args);
  const outcome = applyAction(scope, args.action, target, reason);
  run(
    scope.sql,
    "INSERT INTO moderation_log (created_at, moderator_id, action, target, reason, detail) VALUES (?, ?, ?, ?, ?, ?)",
    scope.now,
    scope.agent.id,
    args.action,
    target,
    reason,
    JSON.stringify(outcome.output),
  );
  return { output: { action: args.action, target, ...outcome.output }, endStreamsFor: outcome.endStreamsFor };
}

function requireTarget(args: ModerateArgs): string {
  const target = args.target?.trim();
  if (!target) throw new ToolError(`${args.action} needs target`);
  return target;
}

function requireReason(args: ModerateArgs): string {
  const reason = args.reason?.trim();
  if (!reason) throw new ToolError(`${args.action} needs reason: say why, for the moderation log`);
  if (reason.length > REASON_MAX_LENGTH) throw new ToolError(`reason is longer than ${REASON_MAX_LENGTH} characters`);
  return reason;
}

function applyAction(scope: Scope, action: Exclude<ModerationAction, "log">, target: string, reason: string): ModerationOutcome {
  switch (action) {
    case "delete_message":
      return deleteAnyMessage(scope, target);
    case "delete_agent_messages":
      return deleteAgentMessages(scope, target);
    case "archive_channel":
      return setChannelArchived(scope, target, true);
    case "unarchive_channel":
      return setChannelArchived(scope, target, false);
    case "ban_agent":
      return banAgent(scope, target, reason);
    case "unban_agent":
      return unban(scope, "agent", agentForModeration(scope, target).id);
    case "ban_owner":
      return banOwner(scope, target, reason);
    case "unban_owner":
      return unban(scope, "owner", ownerForModeration(scope, target).owner_sub);
  }
}

function deleteAnyMessage(scope: Scope, target: string): ModerationOutcome {
  const { conversation, message } = anyMessage(scope, target);
  removeMessage(scope, conversation, message);
  bumpAdminConversationRevision(scope.sql, conversation, scope.agent.owner_sub);
  return { output: { message: target, deleted: true }, endStreamsFor: [] };
}

function deleteAgentMessages(scope: Scope, target: string): ModerationOutcome {
  const agent = agentForModeration(scope, target);
  const messages = all<MessageRow>(
    scope.sql,
    "SELECT * FROM messages WHERE author_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT ?",
    agent.id,
    AGENT_MESSAGES_PER_CALL + 1,
  );
  const batch = messages.slice(0, AGENT_MESSAGES_PER_CALL);
  const affected = new Map<number, ConversationRow>();
  for (const message of batch) {
    const conversation = affected.get(message.conversation_id) ?? one<ConversationRow>(scope.sql, "SELECT * FROM conversations WHERE id = ?", message.conversation_id)!;
    affected.set(conversation.id, conversation);
    removeMessage(scope, conversation, message);
  }
  for (const conversation of affected.values()) bumpAdminConversationRevision(scope.sql, conversation, scope.agent.owner_sub);
  const more = messages.length > AGENT_MESSAGES_PER_CALL;
  return {
    output: { agent: `@${agent.handle}`, deleted: batch.length, ...(more ? { more: true, note: "call again to delete the rest" } : {}) },
    endStreamsFor: [],
  };
}

function anyConversation(scope: Scope, slug: string): ConversationRow {
  const conversation = one<ConversationRow>(scope.sql, "SELECT * FROM conversations WHERE slug = ?", slug.trim().toLowerCase().replace(/^#/, ""));
  if (!conversation) throw new ToolError(`conversation ${slug} not found`);
  return conversation;
}

function anyMessage(scope: Scope, target: string): { conversation: ConversationRow; message: MessageRow } {
  const parsed = parseMessageRef(target);
  const conversation = anyConversation(scope, parsed.conversation);
  const message = one<MessageRow>(scope.sql, "SELECT * FROM messages WHERE conversation_id = ? AND seq = ?", conversation.id, parsed.seq);
  if (!message) throw new ToolError(`message ${target} not found`);
  return { conversation, message };
}

function anyChannel(scope: Scope, target: string): ConversationRow {
  const conversation = anyConversation(scope, target);
  if (conversation.kind !== "public" && conversation.kind !== "private") throw new ToolError(`${target} is a private chat, not a channel`);
  return conversation;
}

function setChannelArchived(scope: Scope, target: string, archived: boolean): ModerationOutcome {
  const channel = anyChannel(scope, target);
  const archivedAt = archived ? (channel.archived_at ?? scope.now) : null;
  run(scope.sql, "UPDATE conversations SET archived_at = ? WHERE id = ?", archivedAt, channel.id);
  bumpAdminConversationRevision(scope.sql, channel, scope.agent.owner_sub);
  return { output: { channel: label(channel), archived }, endStreamsFor: [] };
}

function banAgent(scope: Scope, target: string, reason: string): ModerationOutcome {
  const agent = agentForModeration(scope, target);
  refuseModeratorTarget(scope, agent.owner_sub);
  if (one(scope.sql, "SELECT 1 AS banned FROM bans WHERE kind = 'agent' AND subject = ?", agent.id)) {
    return { output: { agent: `@${agent.handle}`, banned: true, already: true }, endStreamsFor: [] };
  }
  insertBan(scope, { kind: "agent", subject: agent.id, ownerSub: agent.owner_sub, label: `@${agent.handle}`, reason });
  endTickets(scope, [agent.id]);
  bumpAdminPublicRevision(scope.sql);
  return { output: { agent: `@${agent.handle}`, banned: true }, endStreamsFor: [agent.id] };
}

function banOwner(scope: Scope, target: string, reason: string): ModerationOutcome {
  const owner = ownerForModeration(scope, target);
  refuseModeratorTarget(scope, owner.owner_sub);
  const ownerLabel = `@${ownerPartOfHandle(owner.handle)}`;
  if (isOwnerBanned(scope, owner.owner_sub)) return { output: { owner: ownerLabel, banned: true, already: true }, endStreamsFor: [] };
  insertBan(scope, { kind: "owner", subject: owner.owner_sub, ownerSub: owner.owner_sub, label: ownerLabel, reason });
  const ownedAgents = all<{ id: string }>(scope.sql, "SELECT id FROM agents WHERE owner_sub = ?", owner.owner_sub).map((row) => row.id);
  endTickets(scope, ownedAgents);
  bumpAdminPublicRevision(scope.sql);
  return { output: { owner: ownerLabel, banned: true, agents_locked: ownedAgents.length }, endStreamsFor: ownedAgents };
}

function unban(scope: Scope, kind: "agent" | "owner", subject: string): ModerationOutcome {
  const ban = one<BanRow>(scope.sql, "SELECT * FROM bans WHERE kind = ? AND subject = ?", kind, subject);
  if (!ban) throw new ToolError(`no ${kind} ban for ${subject}; moderate with action 'log' lists recent bans`);
  run(scope.sql, "DELETE FROM bans WHERE kind = ? AND subject = ?", kind, subject);
  bumpAdminPublicRevision(scope.sql);
  return { output: { [kind]: ban.label, banned: false }, endStreamsFor: [] };
}

interface NewBan {
  kind: "agent" | "owner";
  subject: string;
  ownerSub: string;
  label: string;
  reason: string;
}

function insertBan(scope: Scope, ban: NewBan): void {
  run(
    scope.sql,
    "INSERT INTO bans (kind, subject, owner_sub, label, banned_at, banned_by, reason) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ban.kind,
    ban.subject,
    ban.ownerSub,
    ban.label,
    scope.now,
    scope.agent.id,
    ban.reason,
  );
}

function endTickets(scope: Scope, agentIds: string[]): void {
  for (const agentId of agentIds) run(scope.sql, "DELETE FROM stream_tickets WHERE agent_id = ?", agentId);
}

function refuseModeratorTarget(scope: Scope, ownerSub: string): void {
  if (isModerator(scope, ownerSub)) throw new ToolError("moderators cannot be banned; a workspace admin must clear their admin flag first");
}

function agentForModeration(scope: Scope, target: string): AgentRow {
  const handle = target.toLowerCase().replace(/^@/, "");
  if (!handle.includes("/")) throw new ToolError(`'${target}' is not an agent handle; pass '@owner/name'`);
  const agent = one<AgentRow>(scope.sql, "SELECT * FROM agents WHERE handle = ?", handle);
  if (!agent) throw new ToolError(`agent @${handle} not found`);
  return agent;
}

function ownerForModeration(scope: Scope, target: string): AgentRow {
  const owner = target.toLowerCase().replace(/^@/, "").split("/")[0];
  const agent = one<AgentRow>(scope.sql, "SELECT * FROM agents WHERE handle LIKE ? ESCAPE '\\' ORDER BY created_at LIMIT 1", `${escapeLike(owner)}/%`);
  if (!agent) throw new ToolError(`no agents owned by @${owner}; pass '@owner' or one of their agents' handles`);
  return agent;
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function recentLog(scope: Scope) {
  return all<{ created_at: number; handle: string; action: string; target: string; reason: string }>(
    scope.sql,
    `SELECT l.created_at, a.handle, l.action, l.target, l.reason FROM moderation_log l JOIN agents a ON a.id = l.moderator_id
     ORDER BY l.id DESC LIMIT ?`,
    LOG_PAGE,
  ).map((entry) => ({
    time: new Date(entry.created_at).toISOString(),
    moderator: `@${entry.handle}`,
    action: entry.action,
    target: entry.target,
    reason: entry.reason,
  }));
}
