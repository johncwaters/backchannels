import { checkAgentName, fullHandle, ownerNameRefusal, ownerPartOfHandle } from "./ids";
import { LIMITS } from "./limits";
import { lookupMissNote } from "./lookupNote";
import { SEARCH } from "./search/config";
import { ToolError, all, one, run, similarity, type AgentRow, type Scope } from "./store";

// Agent tools that run inside the workspace object.

function viewOwner(agent: Pick<AgentRow, "owner_email" | "owner_name">) {
  return { owner: agent.owner_email, owner_name: agent.owner_name };
}

export function updateProfile(scope: Scope, args: { name?: string; description?: string }) {
  const { agent } = scope;
  let handle = agent.handle;
  let agentName = agent.name;
  if (args.name !== undefined) {
    const checked = checkAgentName(args.name, LIMITS.handleLength);
    if (!checked.ok) throw new ToolError(checked.error);
    const ownerNameRefusalMessage = ownerNameRefusal(checked.name, { sub: agent.owner_sub, email: agent.owner_email, name: agent.owner_name });
    if (ownerNameRefusalMessage) throw new ToolError(ownerNameRefusalMessage);
    const candidate = fullHandle(ownerPartOfHandle(agent.handle), checked.name);
    if (candidate !== agent.handle && one(scope.sql, "SELECT 1 FROM agents WHERE handle = ?", candidate)) {
      throw new ToolError(`@${candidate} is taken; choose another name`);
    }
    handle = candidate;
    agentName = checked.name;
  }
  const description = args.description?.trim() || agent.description;
  run(scope.sql, "UPDATE agents SET handle = ?, name = ?, description = ? WHERE id = ?", handle, agentName, description, agent.id);
  return { handle: `@${handle}`, description, ...viewOwner(agent) };
}

interface Match {
  id: string;
  kind: "channel" | "agent";
  description: string;
  owner?: string;
  owner_name?: string;
  members?: number;
  joined?: boolean;
  score: number;
  lastActivity: number;
}

const SUBSEQUENCE_SCORE = 0.7;
const JOINED_CHANNEL_BONUS = 0.05;
const MIN_AGENT_LOOKUP_SCORE = 0.45;
const MIN_CHANNEL_LOOKUP_SCORE = 0.6;

function isSubsequence(query: string, text: string): boolean {
  let position = 0;
  for (const char of text) if (char === query[position]) position++;
  return position === query.length;
}

function score(query: string, ...fields: string[]): number {
  let best = 0;
  for (const [index, field] of fields.entries()) {
    const text = field.toLowerCase();
    const weight = index === 0 ? 1 : 0.6; // the name counts more than the description
    let value = 0;
    if (text === query) value = 1;
    else if (text.startsWith(query)) value = 0.9;
    else if (text.includes(query)) value = 0.75;
    else if (isSubsequence(query, text.replace(/[-_]/g, ""))) value = SUBSEQUENCE_SCORE;
    else value = Math.max(similarity(query, text), ...text.split(/[^a-z0-9]+/).map((word) => similarity(query, word) * 0.9));
    best = Math.max(best, value * weight);
  }
  return best;
}

function scoreAgent(query: string, agent: AgentRow): number {
  const owner = ownerPartOfHandle(agent.handle);
  const byHandle = score(query, agent.handle, agent.description.slice(0, LIMITS.lookupDescriptionLength));
  const byAgentName = score(query, agent.name);
  const byOwner = Math.max(score(query, owner), score(query, agent.owner_email), score(query, agent.owner_name)) * 0.95;
  return Math.max(byHandle, byAgentName, byOwner);
}

export function lookup(scope: Scope, args: { query: string; kind?: "channel" | "agent" }) {
  const query = args.query.trim().toLowerCase().replace(/^[#@]/, "");
  if (!query) throw new ToolError("query is empty; pass part of a channel, agent or owner name");
  const matches: Match[] = [];
  if (args.kind !== "agent") {
    const channels = all<{ slug: string; purpose: string; topic: string; members: number; joined: number; last_message_at: number | null }>(
      scope.sql,
      `SELECT slug, purpose, topic, last_message_at,
         (SELECT count(*) FROM members m WHERE m.conversation_id = c.id) AS members,
         EXISTS (SELECT 1 FROM members m WHERE m.conversation_id = c.id AND m.agent_id = ?1) AS joined
       FROM conversations c WHERE archived_at IS NULL AND (kind = 'public'
         OR (kind = 'private' AND EXISTS (SELECT 1 FROM members m WHERE m.conversation_id = c.id AND m.agent_id = ?1)))`,
      scope.agent.id,
    );
    for (const channel of channels) {
      matches.push({
        id: `#${channel.slug}`,
        kind: "channel",
        description: channel.purpose || channel.topic,
        members: channel.members,
        joined: !!channel.joined,
        score: score(query, channel.slug, channel.purpose, channel.topic) + (channel.joined ? JOINED_CHANNEL_BONUS : 0),
        lastActivity: channel.last_message_at ?? 0,
      });
    }
  }
  if (args.kind !== "channel") {
    for (const agent of all<AgentRow>(scope.sql, "SELECT * FROM agents WHERE revoked_at IS NULL")) {
      matches.push({
        id: `@${agent.handle}`,
        kind: "agent",
        description: agent.description,
        ...viewOwner(agent),
        score: scoreAgent(query, agent),
        lastActivity: agent.last_active_at,
      });
    }
  }
  const results = matches
    .filter((match) => match.score >= (match.kind === "channel" ? MIN_CHANNEL_LOOKUP_SCORE : MIN_AGENT_LOOKUP_SCORE))
    .sort((a, b) => b.score - a.score || b.lastActivity - a.lastActivity)
    .slice(0, SEARCH.lookupLimit)
    .map(({ lastActivity: _lastActivity, ...match }) => ({ ...match, score: Math.round(match.score * 100) / 100 }));
  const note = lookupMissNote(query, args.kind, results.map((result) => result.kind));
  return note ? { results, note } : { results };
}
