import { ToolError, all, label, messageRef, one, viewMessage, type ConversationRow, type MessageRow, type Scope } from "../store";
import { SEARCH, SEMANTIC, withOverrides, type Tuning, type TuningOverrides } from "./config";
import { missingTerms, termPattern, weakMatchNote } from "./coverage";
import { buildFilters, type Filters } from "./filters";
import { ftsMatch, parseQuery, withoutStopWords, type FreeTerm, type ParsedQuery, type SortOrder } from "./query";
import { fuse, lexicalCandidates, messageIdsForVectorHits, privateConversationIds, recheckVisible, rerank, type Ranked } from "./rank";
import { crossEncoderScores, searchVectors, withTimeout } from "./semantic";
import { bumpUsefulness } from "./signals";

type Detail = "concise" | "full";

interface SearchArgs {
  query?: string;
  sort?: SortOrder;
  limit?: number;
  cursor?: string;
  detail?: Detail;
}

interface ResultRow extends MessageRow {
  slug: string;
  kind: ConversationRow["kind"];
  author_handle: string;
  owner_email: string;
}

export function matchOffsets(text: string, terms: FreeTerm[]): [number, number][] {
  const spans: [number, number][] = [];
  for (const term of terms) {
    for (const match of text.matchAll(new RegExp(termPattern(term), "giu"))) spans.push([match.index!, match.index! + match[0].length]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  return merged;
}

async function semanticLeg(
  scope: Scope,
  parsed: ParsedQuery,
  filters: Filters,
  excludeMatch: string | null,
  visibleIds: number[],
): Promise<number[]> {
  if (!parsed.freeText || filters.matchesNothing) return [];
  const search = searchVectors(scope.env, scope.workspaceId, parsed.freeText, filters.vector, visibleIds).catch((error) => {
    console.error("semantic leg failed; lexical results only", error);
    return [];
  });
  const hits = await withTimeout(search, SEMANTIC.timeoutMs, []);
  const candidates = messageIdsForVectorHits(scope, hits);
  return recheckVisible(scope, candidates, visibleIds, { filters, excludeMatch });
}

function wantsCrossEncoder(freeText: string): boolean {
  const words = freeText.trim().split(/\s+/).filter(Boolean).length;
  return words >= SEMANTIC.rerankMinWords || freeText.trim().endsWith("?");
}

function minMax(values: number[]): number[] {
  const low = Math.min(...values);
  const high = Math.max(...values);
  return values.map((value) => (high === low ? 1 : (value - low) / (high - low)));
}

async function withCrossEncoder(scope: Scope, ranked: Ranked[], freeText: string, startedAt: number, tuning: Tuning): Promise<Ranked[]> {
  if (!wantsCrossEncoder(freeText) || ranked.length < 2 || Date.now() - startedAt > tuning.rerankBudgetMs) return ranked;
  const head = ranked.slice(0, SEMANTIC.rerankCandidates);
  const textById = new Map(
    all<{ id: number; text: string }>(scope.sql, "SELECT id, text FROM messages WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(head.map((item) => item.id))).map(
      (row) => [row.id, row.text],
    ),
  );
  try {
    const rerankScores = minMax(await crossEncoderScores(scope.env, freeText, head.map((item) => textById.get(item.id) ?? "")));
    const featureScores = minMax(head.map((item) => item.score));
    const reordered = head
      .map((item, index) => ({
        id: item.id,
        score: SEMANTIC.rerankBlend * rerankScores[index] + (1 - SEMANTIC.rerankBlend) * featureScores[index],
      }))
      .sort((a, b) => b.score - a.score);
    return [...reordered, ...ranked.slice(SEMANTIC.rerankCandidates)];
  } catch (error) {
    console.error("cross-encoder failed; keeping feature order", error);
    return ranked;
  }
}

async function orderedIds(scope: Scope, parsed: ParsedQuery, sort: SortOrder, visibleIds: number[], tuning: Tuning): Promise<number[]> {
  const startedAt = Date.now();
  const filters = buildFilters(scope, parsed.modifiers);
  const excludeMatch = parsed.exclude.length ? ftsMatch(parsed.exclude, "OR") : null;
  if (sort === "recent" || !parsed.include.length) {
    return lexicalCandidates(scope, visibleIds, {
      match: parsed.include.length ? ftsMatch(parsed.include, "AND") : null,
      excludeMatch,
      filters,
      order: "recent",
      limit: SEARCH.recentCandidates,
    });
  }
  const semantic = semanticLeg(scope, parsed, filters, excludeMatch, visibleIds);
  const lexical = lexicalCandidates(scope, visibleIds, {
    match: ftsMatch(withoutStopWords(parsed.include), "OR"),
    excludeMatch,
    filters,
    order: "bm25",
    limit: SEARCH.lexicalCandidates,
  });
  const ranked = rerank(scope, fuse([lexical, await semantic]), parsed.freeText, tuning);
  return (await withCrossEncoder(scope, ranked, parsed.freeText, startedAt, tuning)).map((item) => item.id);
}

async function topForRecent(scope: Scope, parsed: ParsedQuery, recent: number[], visibleIds: number[], tuning: Tuning): Promise<number[] | undefined> {
  if (!parsed.include.length) return undefined;
  const top = (await orderedIds(scope, parsed, "relevant", visibleIds, tuning)).slice(0, SEARCH.topForRecent);
  const firstRecent = new Set(recent.slice(0, SEARCH.topHiddenWhenInFirstRecent));
  if (top.length < SEARCH.topForRecent || top.every((id) => firstRecent.has(id))) return undefined;
  return top;
}

function loadRows(scope: Scope, ids: number[]): Map<number, ResultRow> {
  const rows = all<ResultRow>(
    scope.sql,
    `SELECT m.*, c.slug, c.kind, a.handle AS author_handle, a.owner_email
     FROM json_each(?) j JOIN messages m ON m.id = j.value
     JOIN conversations c ON c.id = m.conversation_id JOIN agents a ON a.id = m.author_id`,
    JSON.stringify(ids),
  );
  return new Map(rows.map((row) => [row.id, row]));
}

function snippets(scope: Scope, ids: number[], terms: FreeTerm[]): Map<number, string> {
  if (!terms.length || !ids.length) return new Map();
  return new Map(
    all<{ id: number; snippet: string }>(
      scope.sql,
      `SELECT rowid AS id, snippet(messages_fts, 0, '**', '**', '…', ?) AS snippet FROM messages_fts
       WHERE messages_fts MATCH ? AND rowid IN (SELECT value FROM json_each(?))`,
      SEARCH.snippetTokens,
      ftsMatch(terms, "OR"),
      JSON.stringify(ids),
    ).map((row) => [row.id, row.snippet]),
  );
}

function neighbour(scope: Scope, row: ResultRow, direction: "previous" | "next") {
  const comparison = direction === "previous" ? "<" : ">";
  const order = direction === "previous" ? "DESC" : "ASC";
  const inSameStream = row.thread_root_id
    ? "(m.thread_root_id = ?2 OR m.id = ?2)"
    : "m.conversation_id = ?2 AND (m.thread_root_id IS NULL OR m.also_in_channel = 1)";
  const found = one<MessageRow>(
    scope.sql,
    `SELECT * FROM messages m WHERE ${inSameStream} AND m.seq ${comparison} ?1 AND m.deleted_at IS NULL ORDER BY m.seq ${order} LIMIT 1`,
    row.seq,
    row.thread_root_id ?? row.conversation_id,
  );
  if (!found) return undefined;
  const conversation = one<ConversationRow>(scope.sql, "SELECT * FROM conversations WHERE id = ?", row.conversation_id)!;
  return viewMessage(scope, conversation, found);
}

function formatResult(scope: Scope, row: ResultRow, snippet: string | undefined, terms: FreeTerm[], detail: Detail) {
  const conversation = { slug: row.slug, kind: row.kind } as ConversationRow;
  const id = messageRef(conversation, row.seq);
  const result: Record<string, unknown> = {
    id,
    conversation: label(conversation),
    author: `@${row.author_handle}`,
    owner: row.owner_email,
    time: new Date(row.created_at).toISOString(),
    snippet: snippet ?? row.text.slice(0, SEARCH.snippetFallbackChars),
    matches: matchOffsets(row.text, terms),
  };
  const missing = missingTerms(row.text, withoutStopWords(terms));
  if (missing.length) result.missing_terms = missing;
  if (row.thread_root_id) {
    const root = one<{ seq: number; text: string }>(scope.sql, "SELECT seq, text FROM messages WHERE id = ?", row.thread_root_id);
    if (root) {
      result.thread = `${messageRef(conversation, root.seq)}/t`;
      result.thread_start = root.text.slice(0, SEARCH.threadStartChars);
    }
  } else if (row.reply_count > 0) {
    result.thread = `${id}/t`;
    result.reply_count = row.reply_count;
  }
  if (detail === "full") {
    const full = viewMessage(scope, { ...conversation, id: row.conversation_id } as ConversationRow, row, true);
    result.text = row.text;
    result.previous = neighbour(scope, row, "previous");
    result.next = neighbour(scope, row, "next");
    if (full.reactions) result.reactions = full.reactions;
    if (full.pinned) result.pinned = true;
    if (full.files) result.files = full.files;
  }
  return result;
}

function encodeCursor(searchId: number, offset: number): string {
  return `s${searchId}.${offset}`;
}

function decodeCursor(cursor: string): { searchId: number; offset: number } {
  const match = /^s(\d+)\.(\d+)$/.exec(cursor);
  if (!match) throw new ToolError("cursor is not valid; pass next_cursor from the previous page");
  return { searchId: Number(match[1]), offset: Number(match[2]) };
}

function page(scope: Scope, searchId: number, ordered: number[], offset: number, limit: number, parsed: ParsedQuery, detail: Detail) {
  const pageIds = ordered.slice(offset, offset + limit);
  const rows = loadRows(scope, pageIds);
  const visible = pageIds.map((id) => rows.get(id)).filter((row): row is ResultRow => !!row && !row.deleted_at);
  const snippetById = snippets(scope, visible.map((row) => row.id), parsed.include);
  const shownPerConversation = new Map<number, number>();
  for (const row of visible) shownPerConversation.set(row.conversation_id, (shownPerConversation.get(row.conversation_id) ?? 0) + 1);
  for (const [conversationId, count] of shownPerConversation) bumpUsefulness(scope, conversationId, "shown", count);
  const nextOffset = offset + limit;
  return {
    results: visible.map((row) => formatResult(scope, row, snippetById.get(row.id), parsed.include, detail)),
    next_cursor: nextOffset < ordered.length ? encodeCursor(searchId, nextOffset) : null,
  };
}

export const SEARCH_TUNING_META_KEY = "search_tuning";

function searchTuning(scope: Scope): Tuning {
  const stored = one<{ value: string }>(scope.sql, "SELECT value FROM meta WHERE key = ?", SEARCH_TUNING_META_KEY);
  return withOverrides(stored ? (JSON.parse(stored.value) as TuningOverrides) : null);
}

export async function searchMessages(scope: Scope, args: SearchArgs) {
  const limit = Math.min(Math.max(args.limit ?? SEARCH.defaultLimit, 1), SEARCH.maxLimit);
  const detail = args.detail ?? "concise";

  if (args.cursor) {
    const { searchId, offset } = decodeCursor(args.cursor);
    const log = one<{ query: string; results: string; created_at: number }>(
      scope.sql,
      "SELECT query, results, created_at FROM search_log WHERE id = ? AND agent_id = ?",
      searchId,
      scope.agent.id,
    );
    if (!log || scope.now - log.created_at > SEARCH.cursorTtlMs) {
      throw new ToolError("this cursor expired (cursors last 10 minutes); run the search again");
    }
    return page(scope, searchId, JSON.parse(log.results), offset, limit, parseQuery(log.query), detail);
  }

  const query = args.query?.trim() ?? "";
  const parsed = parseQuery(query);
  if (!parsed.include.length && !parsed.exclude.length && !parsed.modifiers.length) {
    throw new ToolError("query is empty; describe the problem in words, or use modifiers such as in:#deploys or from:@ian.m");
  }
  const sort = args.sort ?? "relevant";
  const visibleIds = privateConversationIds(scope);
  const tuning = searchTuning(scope);
  const ordered = await orderedIds(scope, parsed, sort, visibleIds, tuning);
  const searchId = one<{ id: number }>(
    scope.sql,
    "INSERT INTO search_log (agent_id, query, sort, results, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
    scope.agent.id,
    query,
    sort,
    JSON.stringify(ordered),
    scope.now,
  )!.id;

  const firstPage = page(scope, searchId, ordered, 0, limit, parsed, detail);
  if (sort === "relevant") {
    const missingPerResult = firstPage.results.map((result) => (result.missing_terms as string[] | undefined) ?? []);
    const note = weakMatchNote(withoutStopWords(parsed.include), missingPerResult);
    if (note) return { note, ...firstPage };
  }
  const top = sort === "recent" ? await topForRecent(scope, parsed, ordered, visibleIds, tuning) : undefined;
  if (!top) return firstPage;
  const topRows = loadRows(scope, top);
  const topSnippets = snippets(scope, top, parsed.include);
  return {
    top: top.flatMap((id) => {
      const row = topRows.get(id);
      return row ? [formatResult(scope, row, topSnippets.get(id), parsed.include, detail)] : [];
    }),
    ...firstPage,
  };
}
