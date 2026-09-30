import { all, type Scope } from "../store";
import { FEATURES, SEARCH, WEIGHTS } from "./config";
import type { Filters } from "./filters";
import { decayed } from "./signals";

const DAY_MS = 24 * 60 * 60_000;
const VISIBLE = "(c.kind = 'public' OR c.id IN (SELECT value FROM json_each(?)))";

export interface LexicalQuery {
  match: string | null;
  excludeMatch: string | null;
  filters: Filters;
  order: "bm25" | "recent";
  limit: number;
}

export interface Ranked {
  id: number;
  score: number;
}

export function privateConversationIds(scope: Scope): number[] {
  return all<{ id: number }>(
    scope.sql,
    `SELECT c.id FROM conversations c JOIN members mem ON mem.conversation_id = c.id
     WHERE mem.agent_id = ? AND c.kind != 'public'`,
    scope.agent.id,
  ).map((row) => row.id);
}

export function lexicalCandidates(scope: Scope, visibleIds: number[], query: LexicalQuery): number[] {
  if (query.filters.matchesNothing) return [];
  const where = ["m.deleted_at IS NULL", VISIBLE, ...query.filters.clauses];
  const params: (string | number)[] = [JSON.stringify(visibleIds), ...query.filters.params];
  if (query.excludeMatch) {
    where.push("m.id NOT IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)");
    params.push(query.excludeMatch);
  }
  const orderBy = query.order === "bm25" && query.match ? "bm25(messages_fts)" : "m.created_at DESC";
  const source = query.match
    ? "messages_fts JOIN messages m ON m.id = messages_fts.rowid JOIN conversations c ON c.id = m.conversation_id"
    : "messages m JOIN conversations c ON c.id = m.conversation_id";
  const matchClause = query.match ? ["messages_fts MATCH ?"] : [];
  return all<{ id: number }>(
    scope.sql,
    `SELECT m.id FROM ${source} WHERE ${[...matchClause, ...where].join(" AND ")} ORDER BY ${orderBy} LIMIT ?`,
    ...(query.match ? [query.match] : []),
    ...params,
    query.limit,
  ).map((row) => row.id);
}

export function fuse(legs: number[][]): Ranked[] {
  const rrf = new Map<number, number>();
  for (const leg of legs) {
    leg.forEach((id, index) => rrf.set(id, (rrf.get(id) ?? 0) + 1 / (SEARCH.rrfK + index + 1)));
  }
  return [...rrf.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, SEARCH.fusedCandidates);
}

interface CandidateRow {
  id: number;
  conversation_id: number;
  kind: string;
  author_id: string;
  created_at: number;
  thread_root_id: number | null;
  reply_count: number;
  has_code: number;
  has_link: number;
  has_file: number;
  word_count: number;
  text: string;
  pinned: number;
}

function normalized(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function byKey<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
  return groups;
}

function threadShape(row: CandidateRow): number {
  if (row.thread_root_id) return 0.3;
  if (row.reply_count >= 3) return 1;
  if (row.reply_count >= 1) return 0.5;
  return 0;
}

export function rerank(scope: Scope, candidates: Ranked[], freeText: string): Ranked[] {
  if (!candidates.length) return [];
  const idsJson = JSON.stringify(candidates.map((candidate) => candidate.id));
  const rows = all<CandidateRow>(
    scope.sql,
    `SELECT m.id, m.conversation_id, c.kind, m.author_id, m.created_at, m.thread_root_id, m.reply_count, m.has_code, m.has_link,
       m.has_file, m.word_count, m.text, EXISTS (SELECT 1 FROM pins p WHERE p.message_id = m.id) AS pinned
     FROM json_each(?) j JOIN messages m ON m.id = j.value JOIN conversations c ON c.id = m.conversation_id`,
    idsJson,
  );
  const conversationsJson = JSON.stringify([...new Set(rows.map((row) => row.conversation_id))]);
  const me = scope.agent.id;

  const affinityToward = new Map(
    all<{ other_id: string; score: number; updated_at: number }>(
      scope.sql,
      "SELECT other_id, score, updated_at FROM agent_affinity WHERE agent_id = ?",
      me,
    ).map((row) => [row.other_id, Math.min(1, decayed(row.score, row.updated_at, scope.now) / FEATURES.affinityScale)]),
  );
  const channelAffinity = new Map(
    all<{ conversation_id: number; score: number; updated_at: number }>(
      scope.sql,
      "SELECT conversation_id, score, updated_at FROM channel_affinity WHERE agent_id = ? AND conversation_id IN (SELECT value FROM json_each(?))",
      me,
      conversationsJson,
    ).map((row) => [row.conversation_id, Math.min(1, decayed(row.score, row.updated_at, scope.now) / FEATURES.affinityScale)]),
  );
  const memberOf = new Set(
    all<{ conversation_id: number }>(
      scope.sql,
      "SELECT conversation_id FROM members WHERE agent_id = ? AND conversation_id IN (SELECT value FROM json_each(?))",
      me,
      conversationsJson,
    ).map((row) => row.conversation_id),
  );
  const levelOverrides = new Map(
    all<{ conversation_id: number; level: string | null }>(
      scope.sql,
      "SELECT conversation_id, level FROM prefs WHERE agent_id = ? AND conversation_id IN (SELECT value FROM json_each(?))",
      me,
      conversationsJson,
    ).map((row) => [row.conversation_id, row.level]),
  );
  const defaultLevel =
    all<{ level: string | null }>(scope.sql, "SELECT level FROM prefs WHERE agent_id = ? AND conversation_id IS NULL", me)[0]?.level ??
    "mentions";
  const usefulness = new Map(
    all<{ conversation_id: number; shown: number; used: number }>(
      scope.sql,
      "SELECT conversation_id, shown, used FROM channel_usefulness WHERE conversation_id IN (SELECT value FROM json_each(?))",
      conversationsJson,
    ).map((row) => [row.conversation_id, row]),
  );
  const reactionsByMessage = byKey(
    all<{ message_id: number; agent_id: string }>(
      scope.sql,
      "SELECT message_id, agent_id FROM reactions WHERE message_id IN (SELECT value FROM json_each(?))",
      idsJson,
    ),
    (row) => row.message_id,
  );
  const repliesByRoot = byKey(
    all<{ root: number; author_id: string }>(
      scope.sql,
      "SELECT thread_root_id AS root, author_id FROM messages WHERE deleted_at IS NULL AND thread_root_id IN (SELECT value FROM json_each(?))",
      idsJson,
    ),
    (row) => row.root,
  );

  const rrfById = new Map(candidates.map((candidate) => [candidate.id, candidate.score]));
  const maxRrf = Math.max(...candidates.map((candidate) => candidate.score));
  const phrase = normalized(freeText);
  const weightOf = (agentId: string) => 1 + (affinityToward.get(agentId) ?? 0);

  return rows
    .map((row) => {
      const isChat = row.kind === "dm" || row.kind === "group";
      const effectiveLevel = levelOverrides.get(row.conversation_id) ?? (isChat ? "all" : defaultLevel);
      let channelPriority = channelAffinity.get(row.conversation_id) ?? 0;
      if (memberOf.has(row.conversation_id)) channelPriority = Math.max(channelPriority, FEATURES.memberChannelPriority);
      if (memberOf.has(row.conversation_id) && effectiveLevel === "all") channelPriority = 1;

      const weightedEngagement =
        (reactionsByMessage.get(row.id) ?? []).reduce((sum, reaction) => sum + weightOf(reaction.agent_id), 0) +
        (repliesByRoot.get(row.id) ?? []).reduce((sum, reply) => sum + FEATURES.replyEngagementWeight * weightOf(reply.author_id), 0) +
        (row.pinned ? FEATURES.pinEngagementWeight : 0);
      const stats = usefulness.get(row.conversation_id);
      const ageDays = (scope.now - row.created_at) / DAY_MS;

      const features = {
        rrf: (rrfById.get(row.id) ?? 0) / maxRrf,
        recency: Math.exp((-Math.LN2 * ageDays) / FEATURES.recencyHalfLifeDays),
        channelPriority,
        authorAffinity: affinityToward.get(row.author_id) ?? 0,
        engagement: Math.min(1, Math.log(1 + weightedEngagement) / Math.log(FEATURES.engagementLogBase)),
        exactPhrase: phrase && normalized(row.text).includes(phrase) ? 1 : 0,
        channelUsefulness:
          ((stats?.used ?? 0) + FEATURES.usefulnessPriorUsed) / ((stats?.shown ?? 0) + FEATURES.usefulnessPriorShown),
        threadShape: threadShape(row),
        ownMessage: row.author_id === me ? 1 : 0,
        formBonus: row.has_code || row.has_link ? 1 : 0,
        shortPenalty: row.word_count < FEATURES.shortMessageWords && !row.has_file ? 1 : 0,
      };
      const score = (Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]).reduce(
        (sum, name) => sum + WEIGHTS[name] * features[name],
        0,
      );
      return { id: row.id, score };
    })
    .sort((a, b) => b.score - a.score);
}
