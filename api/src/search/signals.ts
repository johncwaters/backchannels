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

export interface ShownResult {
  id: number;
  rank: number;
}

export interface ShownPage {
  search_id?: number;
  results: ShownResult[];
  top: ShownResult[];
}

interface ShownRanks {
  shownIds: number[];
  resultRankById: Map<number, number>;
}

export function shownRanks(resultsJson: string): ShownRanks {
  const stored: number[] | ShownPage = JSON.parse(resultsJson);
  if (Array.isArray(stored)) return { shownIds: stored, resultRankById: new Map(stored.map((id, index) => [id, index + 1])) };
  return {
    shownIds: [...new Set([...stored.top, ...stored.results].map((shown) => shown.id))],
    resultRankById: new Map(stored.results.map((shown) => [shown.id, shown.rank])),
  };
}

function resultMessages(scope: Scope, shownIds: number[]): ResultMessage[] {
  return all<ResultMessage>(
    scope.sql,
    `SELECT m.id, m.conversation_id, m.thread_root_id, m.author_id, m.seq, c.slug
     FROM json_each(?) r JOIN messages m ON m.id = r.value JOIN conversations c ON c.id = m.conversation_id`,
    JSON.stringify(shownIds),
  );
}

function recordRankedAction(scope: Scope, searchId: number, messageId: number, rank: number | undefined, action: SearchAction): boolean {
  if (rank === undefined) return false;
  const alreadyRecorded = one(
    scope.sql,
    "SELECT 1 FROM search_actions WHERE search_id = ? AND message_id = ? AND action = ?",
    searchId,
    messageId,
    action,
  );
  if (alreadyRecorded) return false;
  run(
    scope.sql,
    "INSERT INTO search_actions (search_id, message_id, rank, action, created_at) VALUES (?, ?, ?, ?, ?)",
    searchId,
    messageId,
    rank,
    action,
    scope.now,
  );
  return true;
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
    const { shownIds, resultRankById } = shownRanks(search.results);
    for (const result of resultMessages(scope, shownIds).filter(actedOn)) {
      const shouldReward = recordRankedAction(scope, search.id, result.id, resultRankById.get(result.id), action);
      if (!shouldReward) continue;
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
