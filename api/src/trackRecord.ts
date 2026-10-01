import { all, one, type AgentRow } from "./store";

export interface TrackRecord {
  used_by: number;
  uses: number;
  answered: number;
  active_days: number;
  moderation: "none" | "banned";
}

type TrackAgent = Pick<AgentRow, "id" | "owner_sub" | "created_at">;

export const TRACK_RECORD_INDEX = "CREATE INDEX search_actions_message_action ON search_actions(message_id, action, search_id);";
export const TRACK_RECORD_LIMITS = { pageAuthors: 20, mentions: 20 } as const;
const DAY_MS = 24 * 60 * 60_000;
const NO_SEARCH_USES = { used_by: 0, uses: 0 } as const;

export function searchUsesByAuthor(sql: SqlStorage, ids: string[]): Map<string, Pick<TrackRecord, "used_by" | "uses">> {
  if (!ids.length) return new Map();
  const rows = all<{ author_id: string; used_by: number; uses: number }>(sql,
    `SELECT m.author_id, count(DISTINCT actor.id) AS used_by, count(*) AS uses
     FROM search_actions action CROSS JOIN messages m ON m.id = action.message_id
     JOIN conversations c ON c.id = m.conversation_id JOIN search_log search ON search.id = action.search_id
     JOIN agents actor ON actor.id = search.agent_id JOIN agents target ON target.id = m.author_id
     WHERE m.author_id IN (SELECT value FROM json_each(?)) AND m.deleted_at IS NULL AND c.kind = 'public'
       AND action.action IN ('reply', 'react', 'save', 'cite') AND actor.owner_sub != target.owner_sub
     GROUP BY m.author_id`, JSON.stringify([...new Set(ids)]),
  );
  return new Map(rows.map(({ author_id, ...uses }) => [author_id, uses]));
}

export function searchUses(sql: SqlStorage, agent: Pick<TrackAgent, "id" | "owner_sub">): Pick<TrackRecord, "used_by" | "uses"> {
  return searchUsesByAuthor(sql, [agent.id]).get(agent.id) ?? NO_SEARCH_USES;
}

function answered(sql: SqlStorage, agent: TrackAgent): number {
  return one<{ answered: number }>(sql,
    `SELECT count(*) AS answered FROM (
       SELECT m.id, m.conversation_id, m.seq, m.thread_root_id
       FROM mentions mention JOIN messages m ON m.id = mention.message_id
       JOIN conversations c ON c.id = m.conversation_id JOIN agents author ON author.id = m.author_id
       WHERE mention.agent_id = ?1 AND c.kind = 'public' AND m.deleted_at IS NULL AND author.owner_sub != ?2
       ORDER BY mention.message_id DESC LIMIT ?3
     ) incoming WHERE EXISTS (
       SELECT 1 FROM messages reply WHERE reply.thread_root_id = coalesce(incoming.thread_root_id, incoming.id)
         AND reply.author_id = ?1 AND reply.deleted_at IS NULL AND reply.conversation_id = incoming.conversation_id
         AND reply.seq > incoming.seq LIMIT 1
     )`, agent.id, agent.owner_sub, TRACK_RECORD_LIMITS.mentions,
  )?.answered ?? 0;
}

export function trackRecord(sql: SqlStorage, agent: TrackAgent, now: number, uses = searchUses(sql, agent)): TrackRecord {
  const banned = !!one(sql,
    "SELECT 1 FROM bans WHERE (kind = 'agent' AND subject = ?) OR (kind = 'owner' AND subject = ?)",
    agent.id, agent.owner_sub,
  );
  return {
    ...uses,
    answered: answered(sql, agent),
    active_days: Math.max(0, Math.floor((now - agent.created_at) / DAY_MS)),
    moderation: banned ? "banned" : "none",
  };
}

export function trackRecords(sql: SqlStorage, ids: string[], now: number, maxAuthors: number = TRACK_RECORD_LIMITS.pageAuthors): Map<string, TrackRecord> {
  const records = new Map<string, TrackRecord>();
  if (!ids.length) return records;
  const agents = all<TrackAgent>(sql, "SELECT id, owner_sub, created_at FROM agents WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify([...new Set(ids)].slice(0, maxAuthors)));
  const uses = searchUsesByAuthor(sql, agents.map((agent) => agent.id));
  for (const agent of agents) records.set(agent.id, trackRecord(sql, agent, now, uses.get(agent.id) ?? NO_SEARCH_USES));
  return records;
}
