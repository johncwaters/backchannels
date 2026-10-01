import { removeMessage } from "./messages";
import {
  all,
  findChannel,
  findMessage,
  label,
  one,
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

export function moderatorEmails(env: Pick<Env, "MODERATOR_EMAILS"> | Record<string, never>): Set<string> {
  const listed = (env as { MODERATOR_EMAILS?: string }).MODERATOR_EMAILS ?? "";
  return new Set(listed.split(",").map((email) => email.trim().toLowerCase()).filter(Boolean));
}

export function isModerator(env: Pick<Env, "MODERATOR_EMAILS"> | Record<string, never>, email: string): boolean {
  return moderatorEmails(env).has(email.trim().toLowerCase());
}

export function isOwnerBanned(scope: Pick<Scope, "sql">, ownerSub: string): boolean {
  return !!one(scope.sql, "SELECT 1 AS banned FROM bans WHERE kind = 'owner' AND subject = ?", ownerSub);
}

export function moderate(scope: Scope, args: ModerateArgs): ModerationOutcome {
  if (!isModerator(scope.env, scope.agent.owner_email)) {
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
  const { conversation, message } = findMessage(scope, target);
  removeMessage(scope, conversation, message);
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
  for (const message of batch) {
    const conversation = one<ConversationRow>(scope.sql, "SELECT * FROM conversations WHERE id = ?", message.conversation_id)!;
    removeMessage(scope, conversation, message);
  }
  const more = messages.length > AGENT_MESSAGES_PER_CALL;
  return {
    output: { agent: `@${agent.handle}`, deleted: batch.length, ...(more ? { more: true, note: "call again to delete the rest" } : {}) },
    endStreamsFor: [],
  };
}

function setChannelArchived(scope: Scope, target: string, archived: boolean): ModerationOutcome {
  const channel = findChannel(scope, target);
  const archivedAt = archived ? (channel.archived_at ?? scope.now) : null;
  run(scope.sql, "UPDATE conversations SET archived_at = ? WHERE id = ?", archivedAt, channel.id);
  return { output: { channel: label(channel), archived }, endStreamsFor: [] };
}

function banAgent(scope: Scope, target: string, reason: string): ModerationOutcome {
  const agent = agentForModeration(scope, target);
  refuseModeratorTarget(scope, agent.owner_email);
  if (agent.revoked_at !== null) return { output: { agent: `@${agent.handle}`, banned: true, already: true }, endStreamsFor: [] };
  insertBan(scope, { kind: "agent", subject: agent.id, ownerSub: agent.owner_sub, label: `@${agent.handle}`, reason });
  revokeAgents(scope, [agent.id]);
  return { output: { agent: `@${agent.handle}`, banned: true }, endStreamsFor: [agent.id] };
}

function banOwner(scope: Scope, target: string, reason: string): ModerationOutcome {
  const owner = ownerForModeration(scope, target);
  refuseModeratorTarget(scope, owner.owner_email);
  const ownerLabel = `@${ownerPart(owner.handle)}`;
  if (isOwnerBanned(scope, owner.owner_sub)) return { output: { owner: ownerLabel, banned: true, already: true }, endStreamsFor: [] };
  insertBan(scope, { kind: "owner", subject: owner.owner_sub, ownerSub: owner.owner_sub, label: ownerLabel, reason });
  const liveAgents = all<{ id: string }>(scope.sql, "SELECT id FROM agents WHERE owner_sub = ? AND revoked_at IS NULL", owner.owner_sub).map((row) => row.id);
  revokeAgents(scope, liveAgents);
  return { output: { owner: ownerLabel, banned: true, agents_revoked: liveAgents.length }, endStreamsFor: liveAgents };
}

function unban(scope: Scope, kind: "agent" | "owner", subject: string): ModerationOutcome {
  const ban = one<BanRow>(scope.sql, "SELECT * FROM bans WHERE kind = ? AND subject = ?", kind, subject);
  if (!ban) throw new ToolError(`no ${kind} ban for ${subject}; moderate with action 'log' lists recent bans`);
  run(scope.sql, "DELETE FROM bans WHERE kind = ? AND subject = ?", kind, subject);
  const restored =
    kind === "agent"
      ? run(scope.sql, "UPDATE agents SET revoked_at = NULL WHERE id = ? AND revoked_at = ?", subject, ban.banned_at)
      : run(scope.sql, "UPDATE agents SET revoked_at = NULL WHERE owner_sub = ? AND revoked_at = ?", subject, ban.banned_at);
  return { output: { [kind]: ban.label, banned: false, agents_restored: restored }, endStreamsFor: [] };
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

function revokeAgents(scope: Scope, agentIds: string[]): void {
  for (const agentId of agentIds) {
    run(scope.sql, "UPDATE agents SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", scope.now, agentId);
    run(scope.sql, "DELETE FROM stream_tickets WHERE agent_id = ?", agentId);
  }
}

function refuseModeratorTarget(scope: Scope, ownerEmail: string): void {
  if (isModerator(scope.env, ownerEmail)) throw new ToolError("moderators cannot be banned; remove them from MODERATOR_EMAILS first");
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

function ownerPart(handle: string): string {
  return handle.slice(0, handle.indexOf("/"));
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
