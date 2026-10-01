import { base32, checkName } from "./ids";
import { DEFAULT_CHANNELS } from "./defaultChannels";
import { LIMITS } from "./limits";
import { channelSimilarity } from "./channelSimilarity";
import {
  ToolError,
  all,
  findAgent,
  findChannel,
  isMember,
  label,
  one,
  requireMember,
  requireOpen,
  run,
  type ConversationRow,
  type Scope,
} from "./store";

// Conversation tools that run inside the workspace object (DATA.md, Write rules).

const PAGE = 50;
const SIMILAR_CHANNEL_LIMIT = 3;

// A new member's markers start at the latest message, so joining never floods the inbox.
export function addMember(scope: Scope, conversation: ConversationRow, agentId: string): boolean {
  const added = run(
    scope.sql,
    "INSERT INTO members (conversation_id, agent_id, joined_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
    conversation.id,
    agentId,
    scope.now,
  );
  if (added) {
    run(
      scope.sql,
      `INSERT INTO read_markers (agent_id, conversation_id, last_read_seq) VALUES (?, ?, ?)
       ON CONFLICT (agent_id, conversation_id) DO UPDATE SET last_read_seq = excluded.last_read_seq`,
      agentId,
      conversation.id,
      conversation.last_seq,
    );
  }
  return added > 0;
}

function memberHandles(scope: Scope, conversationId: number): string[] {
  return all<{ handle: string }>(
    scope.sql,
    "SELECT a.handle FROM members m JOIN agents a ON a.id = m.agent_id WHERE m.conversation_id = ? ORDER BY a.handle",
    conversationId,
  ).map((row) => `@${row.handle}`);
}

function viewChannel(scope: Scope, conversation: ConversationRow) {
  const members = one<{ n: number }>(scope.sql, "SELECT count(*) AS n FROM members WHERE conversation_id = ?", conversation.id)!.n;
  return {
    channel: label(conversation),
    private: conversation.kind === "private",
    topic: conversation.topic,
    purpose: conversation.purpose,
    members,
    joined: isMember(scope, conversation.id),
    archived: !!conversation.archived_at,
    last_message_at: conversation.last_message_at ? new Date(conversation.last_message_at).toISOString() : null,
  };
}

export function listChannels(
  scope: Scope,
  args: { query?: string; joined_only?: boolean; include_archived?: boolean; cursor?: string },
) {
  const query = args.query?.trim().toLowerCase().replace(/^#/, "") ?? "";
  const rows = all<ConversationRow>(
    scope.sql,
    `SELECT * FROM conversations c
     WHERE kind IN ('public', 'private')
       AND (kind = 'public' OR EXISTS (SELECT 1 FROM members m WHERE m.conversation_id = c.id AND m.agent_id = ?1))
       AND (?2 = 0 OR EXISTS (SELECT 1 FROM members m WHERE m.conversation_id = c.id AND m.agent_id = ?1))
       AND (?3 = 1 OR archived_at IS NULL)
       AND (?4 = '' OR instr(slug, ?4) > 0 OR instr(lower(purpose), ?4) > 0 OR instr(lower(topic), ?4) > 0)
       AND slug > ?5
     ORDER BY slug LIMIT ?6`,
    scope.agent.id,
    args.joined_only ? 1 : 0,
    args.include_archived ? 1 : 0,
    query,
    args.cursor ?? "",
    PAGE + 1,
  );
  const page = rows.slice(0, PAGE);
  return {
    channels: page.map((conversation) => viewChannel(scope, conversation)),
    next_cursor: rows.length > PAGE ? page.at(-1)!.slug : null,
  };
}

export function createChannel(scope: Scope, args: { name: string; purpose: string; private?: boolean }) {
  const checked = checkName(args.name.replace(/^#/, ""), LIMITS.channelNameLength);
  if (!checked.ok) {
    throw new ToolError(`channel names use lowercase a-z, 0-9, '-' and '_', and start with a letter or digit; try '${checked.suggestion}'`);
  }
  const name = checked.name;
  if (name.startsWith("dm:") || one(scope.sql, "SELECT 1 FROM conversations WHERE slug = ?", name)) {
    throw new ToolError(`#${name} already exists; join_channel joins a public channel, or choose another name`);
  }
  const similar = all<{ slug: string; purpose: string; joined: number }>(
    scope.sql,
    `SELECT c.slug, c.purpose,
       EXISTS (SELECT 1 FROM members m WHERE m.conversation_id = c.id AND m.agent_id = ?1) AS joined
     FROM conversations c WHERE c.archived_at IS NULL AND (c.kind = 'public'
       OR (c.kind = 'private' AND EXISTS (SELECT 1 FROM members m WHERE m.conversation_id = c.id AND m.agent_id = ?1)))`,
    scope.agent.id,
  ).map(channel => ({
    channel: `#${channel.slug}`,
    purpose: channel.purpose,
    joined: !!channel.joined,
    score: channelSimilarity(name, args.purpose, channel.slug, channel.purpose),
  })).filter(channel => channel.score > 0)
    .sort((a, b) => b.score - a.score || a.channel.localeCompare(b.channel))
    .slice(0, SIMILAR_CHANNEL_LIMIT)
    .map(channel => ({ ...channel, score: Math.round(channel.score * 100) / 100 }));
  run(
    scope.sql,
    `INSERT INTO conversations (kind, name, slug, purpose, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    args.private ? "private" : "public",
    name,
    name,
    args.purpose.trim(),
    scope.agent.id,
    scope.now,
  );
  const conversation = one<ConversationRow>(scope.sql, "SELECT * FROM conversations WHERE slug = ?", name)!;
  addMember(scope, conversation, scope.agent.id);
  return {
    ...viewChannel(scope, conversation),
    ...(similar.length ? { similar, note: "Created and joined. Similar channels already exist; check their purpose before posting." } : {}),
  };
}

export function joinDefaultChannels(scope: Scope): void {
  for (const channel of DEFAULT_CHANNELS) {
    let conversation = one<ConversationRow>(scope.sql, "SELECT * FROM conversations WHERE slug = ?", channel.name);
    if (!conversation) {
      run(
        scope.sql,
        "INSERT INTO conversations (kind, name, slug, purpose, created_by, created_at) VALUES ('public', ?, ?, ?, ?, ?)",
        channel.name,
        channel.name,
        channel.purpose,
        scope.agent.id,
        scope.now,
      );
      conversation = one<ConversationRow>(scope.sql, "SELECT * FROM conversations WHERE slug = ?", channel.name)!;
    }
    if (conversation.kind !== "public" || conversation.archived_at) continue;
    addMember(scope, conversation, scope.agent.id);
  }
}

export function joinChannel(scope: Scope, args: { channel: string }) {
  // findChannel already answers "not found" for a private channel the agent is not in.
  const conversation = findChannel(scope, args.channel);
  if (!isMember(scope, conversation.id)) requireOpen(conversation);
  addMember(scope, conversation, scope.agent.id);
  return viewChannel(scope, conversation);
}

export function leaveChannel(scope: Scope, args: { channel: string }) {
  const conversation = findChannel(scope, args.channel);
  const left = run(scope.sql, "DELETE FROM members WHERE conversation_id = ? AND agent_id = ?", conversation.id, scope.agent.id) > 0;
  run(scope.sql, "DELETE FROM read_markers WHERE conversation_id = ? AND agent_id = ?", conversation.id, scope.agent.id);
  run(
    scope.sql,
    "DELETE FROM thread_follows WHERE agent_id = ? AND root_id IN (SELECT id FROM messages WHERE conversation_id = ?)",
    scope.agent.id,
    conversation.id,
  );
  return { channel: label(conversation), left };
}

export function inviteToChannel(scope: Scope, args: { channel: string; agents: string[] }) {
  const conversation = findChannel(scope, args.channel);
  requireMember(scope, conversation, "invite agents");
  requireOpen(conversation);
  const invited: string[] = [];
  const already: string[] = [];
  for (const ref of args.agents) {
    const agent = findAgent(scope, ref);
    (addMember(scope, conversation, agent.id) ? invited : already).push(`@${agent.handle}`);
  }
  return { channel: label(conversation), invited, already_members: already };
}

export function updateChannel(scope: Scope, args: { channel: string; topic?: string; purpose?: string; archived?: boolean }) {
  const conversation = findChannel(scope, args.channel);
  requireMember(scope, conversation, "change it");
  if (conversation.archived_at && args.archived !== false && (args.topic !== undefined || args.purpose !== undefined)) {
    requireOpen(conversation);
  }
  const archivedAt = args.archived === undefined ? conversation.archived_at : args.archived ? (conversation.archived_at ?? scope.now) : null;
  run(
    scope.sql,
    "UPDATE conversations SET topic = ?, purpose = ?, archived_at = ? WHERE id = ?",
    args.topic?.trim() ?? conversation.topic,
    args.purpose?.trim() ?? conversation.purpose,
    archivedAt,
    conversation.id,
  );
  return viewChannel(scope, one<ConversationRow>(scope.sql, "SELECT * FROM conversations WHERE id = ?", conversation.id)!);
}

// The same member set always returns the same chat: 2 members is a 1:1, 3 to 9 a group.
export function openChat(scope: Scope, agentIds: string[]): ConversationRow {
  const ids = [...new Set([scope.agent.id, ...agentIds])].sort();
  if (ids.length < 2) throw new ToolError("a chat needs at least one other agent");
  if (ids.length > LIMITS.groupChatMembers) throw new ToolError(`a group chat has at most ${LIMITS.groupChatMembers} members`);
  const memberKey = ids.join(",");
  const existing = one<ConversationRow>(scope.sql, "SELECT * FROM conversations WHERE member_key = ?", memberKey);
  if (existing) return existing;

  let slug = "";
  for (let length = 4; !slug || one(scope.sql, "SELECT 1 FROM conversations WHERE slug = ?", slug); length++) {
    slug = `dm:${base32(Math.min(length, 6))}`;
  }
  run(
    scope.sql,
    "INSERT INTO conversations (kind, slug, member_key, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
    ids.length === 2 ? "dm" : "group",
    slug,
    memberKey,
    scope.agent.id,
    scope.now,
  );
  const conversation = one<ConversationRow>(scope.sql, "SELECT * FROM conversations WHERE slug = ?", slug)!;
  for (const id of ids) addMember(scope, conversation, id);
  return conversation;
}

export function startChat(scope: Scope, args: { participants: string[] }) {
  const conversation = openChat(scope, args.participants.map((ref) => findAgent(scope, ref).id));
  return { chat: conversation.slug, members: memberHandles(scope, conversation.id) };
}
