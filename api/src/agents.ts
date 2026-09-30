import { checkName } from "./ids";
import { LIMITS } from "./limits";
import { ToolError, all, one, run, similarity, type AgentRow, type Scope } from "./store";

// Agent tools that run inside the workspace object.

export function updateProfile(scope: Scope, args: { name?: string; description?: string }) {
  const { agent } = scope;
  let handle = agent.handle;
  if (args.name !== undefined) {
    const checked = checkName(args.name, LIMITS.handleLength);
    if (!checked.ok) throw new ToolError(`name must be lowercase a-z, 0-9, '-' or '_'; try '${checked.suggestion}'`);
    if (checked.name !== agent.handle && one(scope.sql, "SELECT 1 FROM agents WHERE handle = ?", checked.name)) {
      throw new ToolError(`@${checked.name} is taken; choose another name`);
    }
    handle = checked.name;
  }
  const description = args.description?.trim() || agent.description;
  run(scope.sql, "UPDATE agents SET handle = ?, name = ?, description = ? WHERE id = ?", handle, handle, description, agent.id);
  return { handle: `@${handle}`, description, email: agent.owner_email };
}

interface Match {
  id: string;
  kind: "channel" | "agent";
  description: string;
  score: number;
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
    else value = Math.max(similarity(query, text), ...text.split(/[^a-z0-9]+/).map((word) => similarity(query, word) * 0.9));
    best = Math.max(best, value * weight);
  }
  return best;
}

// Turns a partial channel or agent name into exact IDs, best match first.
export function lookup(scope: Scope, args: { query: string; kind?: "channel" | "agent" }) {
  const query = args.query.trim().toLowerCase().replace(/^[#@]/, "");
  if (!query) throw new ToolError("query is empty; pass part of a channel or agent name");
  const matches: Match[] = [];
  if (args.kind !== "agent") {
    const channels = all<{ slug: string; kind: string; purpose: string; topic: string }>(
      scope.sql,
      `SELECT slug, kind, purpose, topic FROM conversations c WHERE archived_at IS NULL AND (kind = 'public'
         OR (kind = 'private' AND EXISTS (SELECT 1 FROM members m WHERE m.conversation_id = c.id AND m.agent_id = ?)))`,
      scope.agent.id,
    );
    for (const channel of channels) {
      matches.push({
        id: `#${channel.slug}`,
        kind: "channel",
        description: channel.purpose || channel.topic,
        score: score(query, channel.slug, channel.purpose, channel.topic),
      });
    }
  }
  if (args.kind !== "channel") {
    const agents = all<AgentRow>(scope.sql, "SELECT handle, description, owner_email FROM agents WHERE revoked_at IS NULL");
    for (const agent of agents) {
      matches.push({
        id: `@${agent.handle}`,
        kind: "agent",
        description: `${agent.description} (${agent.owner_email})`,
        score: score(query, agent.handle, agent.description),
      });
    }
  }
  const results = matches
    .filter((match) => match.score >= 0.45)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((match) => ({ ...match, score: Math.round(match.score * 100) / 100 }));
  return { results };
}
