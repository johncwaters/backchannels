import { all, one, run, type Scope } from "../store";
import { SEARCH, SIGNALS } from "./config";

export type SearchAction = "open" | "reply" | "react" | "save" | "cite";

export interface ResultMessage {
  id: number;
  conversation_id: number;
  thread_root_id: number | null;
  author_id: string;
  seq: number;
  slug: string;
}

export function decayed(score: number, updatedAt: number, now: number): number {
  return score * Math.exp(-(now - updatedAt) / SIGNALS.decayTauMs);
}

export function bumpAgentAffinity(scope: Scope, fromAgent: string, toAgent: string, increment: number): void {
  if (fromAgent === toAgent) return;
  const current = one<{ score: number; updated_at: number }>(
    scope.sql,
    "SELECT score, updated_at FROM agent_affinity WHERE agent_id = ? AND other_id = ?",
    fromAgent,
    toAgent,
  );
  const score = (current ? decayed(current.score, current.updated_at, scope.now) : 0) + increment;
  run(
    scope.sql,
    `INSERT INTO agent_affinity (agent_id, other_id, score, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (agent_id, other_id) DO UPDATE SET score = excluded.score, updated_at = excluded.updated_at`,
    fromAgent,
    toAgent,
    score,
    scope.now,
  );
}

export function bumpMutualAffinity(scope: Scope, agentA: string, agentB: string, increment: number): void {
  bumpAgentAffinity(scope, agentA, agentB, increment);
  bumpAgentAffinity(scope, agentB, agentA, increment);
}

export function bumpChannelAffinity(scope: Scope, conversationId: number, increment: number, agentId = scope.agent.id): void {
  const current = one<{ score: number; updated_at: number }>(
    scope.sql,
    "SELECT score, updated_at FROM channel_affinity WHERE agent_id = ? AND conversation_id = ?",
    agentId,
    conversationId,
  );
  const score = (current ? decayed(current.score, current.updated_at, scope.now) : 0) + increment;
  run(
    scope.sql,
    `INSERT INTO channel_affinity (agent_id, conversation_id, score, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (agent_id, conversation_id) DO UPDATE SET score = excluded.score, updated_at = excluded.updated_at`,
    agentId,
    conversationId,
    score,
    scope.now,
  );
}

export function bumpUsefulness(scope: Scope, conversationId: number, column: "shown" | "used", amount = 1): void {
  run(
    scope.sql,
    `INSERT INTO channel_usefulness (conversation_id, ${column}) VALUES (?, ?)
     ON CONFLICT (conversation_id) DO UPDATE SET ${column} = ${column} + excluded.${column}`,
    conversationId,
    amount,
  );
}

function resultMessages(scope: Scope, resultsJson: string): ResultMessage[] {
  return all<ResultMessage>(
    scope.sql,
    `SELECT m.id, m.conversation_id, m.thread_root_id, m.author_id, m.seq, c.slug
     FROM json_each(?) r JOIN messages m ON m.id = r.value JOIN conversations c ON c.id = m.conversation_id`,
    resultsJson,
  );
}

export function recordSearchActions(scope: Scope, action: SearchAction, actedOn: (result: ResultMessage) => boolean): void {
  const searches = all<{ id: number; results: string }>(
    scope.sql,
    "SELECT id, results FROM search_log WHERE agent_id = ? AND created_at >= ? ORDER BY id DESC LIMIT ?",
    scope.agent.id,
    scope.now - SEARCH.actionWindowMs,
    SEARCH.recentSearchesCheckedForActions,
  );
  const rewarded = new Set<number>();
  for (const search of searches) {
    const ranked: number[] = JSON.parse(search.results);
    for (const result of resultMessages(scope, search.results).filter(actedOn)) {
      const alreadyRecorded = one(
        scope.sql,
        "SELECT 1 FROM search_actions WHERE search_id = ? AND message_id = ? AND action = ?",
        search.id,
        result.id,
        action,
      );
      if (alreadyRecorded) continue;
      run(
        scope.sql,
        "INSERT INTO search_actions (search_id, message_id, rank, action, created_at) VALUES (?, ?, ?, ?, ?)",
        search.id,
        result.id,
        ranked.indexOf(result.id) + 1,
        action,
        scope.now,
      );
      if (rewarded.has(result.id)) continue;
      rewarded.add(result.id);
      bumpUsefulness(scope, result.conversation_id, "used");
      bumpAgentAffinity(scope, scope.agent.id, result.author_id, SIGNALS.searchAction);
      bumpChannelAffinity(scope, result.conversation_id, SIGNALS.channelSearchAction);
    }
  }
}

export function messageRefText(result: ResultMessage): string {
  return `${result.slug}/${result.seq}`;
}
