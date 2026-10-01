import { ToolError, all, label, messageRef, one, run, viewMessage, type ConversationRow, type MessageRow, type Scope } from "../store";
import { SEARCH, SEMANTIC, withOverrides, type Tuning, type TuningOverrides } from "./config";
import { missingTerms, termPattern } from "./coverage";
import { buildFilters, type Filters } from "./filters";
import { ftsMatch, parseQuery, withoutStopWords, type FreeTerm, type ParsedQuery, type SortOrder } from "./query";
import { fuse, lexicalCandidates, messageIdsForVectorHits, privateConversationIds, recheckVisible, rerank, type Ranked } from "./rank";
import { crossEncoderScores, searchVectors, withTimeout } from "./semantic";
import { bumpUsefulness, type ShownPage } from "./signals";

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
  tuning: Tuning,
): Promise<number[]> {
  if (!parsed.freeText || filters.matchesNothing) return [];
  const search = searchVectors(scope.env, scope.workspaceId, parsed.freeText, filters.vector, visibleIds).catch((error) => {
    console.error("semantic leg failed; lexical results only", error);
    return [];
  });
  const hits = (await withTimeout(search, tuning.semanticTimeoutMs, [])).filter((hit) => hit.score >= tuning.features.semanticMinScore);
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

export interface Searcher {
  privateIds: number[];
  selfIds: string[];
  onlyIn?: number[];
  hideArchived?: boolean;
}

function searcherFilters(scope: Scope, parsed: ParsedQuery, searcher: Searcher): Filters {
  const filters = buildFilters(scope, parsed.modifiers, searcher.selfIds);
  if (searcher.hideArchived) filters.clauses.push("c.archived_at IS NULL");
  if (!searcher.onlyIn) return filters;
  const allowed = new Set(searcher.onlyIn);
  if (filters.vector.conversationIds) {
    filters.vector.conversationIds = filters.vector.conversationIds.filter((id) => allowed.has(id));
    if (!filters.vector.conversationIds.length) filters.matchesNothing = true;
  }
  filters.clauses.push("m.conversation_id IN (SELECT value FROM json_each(?))");
  filters.params.push(JSON.stringify(searcher.onlyIn));
  return filters;
}

function termsMatchedById(scope: Scope, ids: number[], terms: FreeTerm[]): Map<number, number> {
  const textById = all<{ id: number; text: string }>(
    scope.sql,
    "SELECT id, text FROM messages WHERE id IN (SELECT value FROM json_each(?))",
    JSON.stringify(ids),
  );
  return new Map(textById.map((row) => [row.id, terms.length - missingTerms(row.text, terms).length]));
}

function withoutWeakLexicalHits(scope: Scope, lexical: number[], semantic: Set<number>, terms: FreeTerm[], tuning: Tuning): number[] {
  const { lexicalOnlyMinTerms, lexicalOnlyFromTerms } = tuning.features;
  if (terms.length < lexicalOnlyFromTerms || !lexical.length) return lexical;
  const matchedById = termsMatchedById(scope, lexical, terms);
  return lexical.filter((id) => semantic.has(id) || (matchedById.get(id) ?? 0) >= lexicalOnlyMinTerms);
}

async function orderedIds(scope: Scope, parsed: ParsedQuery, sort: SortOrder, searcher: Searcher, tuning: Tuning): Promise<number[]> {
  const startedAt = Date.now();
  const visibleIds = searcher.privateIds;
  const filters = searcherFilters(scope, parsed, searcher);
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
  const semantic = semanticLeg(scope, parsed, filters, excludeMatch, visibleIds, tuning);
  const lexical = lexicalCandidates(scope, visibleIds, {
    match: ftsMatch(withoutStopWords(parsed.include), "OR"),
    excludeMatch,
    filters,
    order: "bm25",
    limit: SEARCH.lexicalCandidates,
  });
  const semanticHits = await semantic;
  const lexicalKept = withoutWeakLexicalHits(scope, lexical, new Set(semanticHits), withoutStopWords(parsed.include), tuning);
  const ranked = rerank(scope, fuse([lexicalKept, semanticHits]), parsed.freeText, tuning);
  return (await withCrossEncoder(scope, ranked, parsed.freeText, startedAt, tuning)).map((item) => item.id);
}

async function topForRecent(scope: Scope, parsed: ParsedQuery, recent: number[], searcher: Searcher, tuning: Tuning): Promise<number[] | undefined> {
  if (!parsed.include.length) return undefined;
  const relevant = await orderedIds(scope, parsed, "relevant", searcher, tuning);
  const counted = withoutStopWords(parsed.include);
  const matchedById = termsMatchedById(scope, relevant, counted);
  const top = relevant.filter((id) => matchedById.get(id) === counted.length).slice(0, SEARCH.topForRecent);
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
  };
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

const SEARCH_CURSOR_PREFIX = "search_cursor:";

function page(
  scope: Scope,
  ordered: number[],
  offset: number,
  limit: number,
  parsed: ParsedQuery,
  detail: Detail,
  session: { id?: number; query: string; sort: SortOrder },
  top: number[] = [],
) {
  const pageIds = ordered.slice(offset, offset + limit);
  const rows = loadRows(scope, [...pageIds, ...top]);
  const privateIds = new Set(privateConversationIds(scope));
  const visibleRows = (ids: number[]) => ids.map((id) => rows.get(id)).filter((row): row is ResultRow =>
    !!row && row.deleted_at === null && (row.kind === "public" || privateIds.has(row.conversation_id)),
  );
  const visible = visibleRows(pageIds);
  const visibleTop = visibleRows(top);
  const shown = [...new Map([...visibleTop, ...visible].map((row) => [row.id, row])).values()];
  const shownIds = shown.map((row) => row.id);
  const snippetById = snippets(scope, shownIds, parsed.include);
  const pageRankById = new Map(pageIds.map((id, index) => [id, offset + index + 1]));
  const topRankById = new Map(top.map((id, index) => [id, index + 1]));
  const shownPage: ShownPage = {
    ...(session.id === undefined ? {} : { search_id: session.id }),
    results: visible.map((row) => ({ id: row.id, rank: pageRankById.get(row.id)! })),
    top: visibleTop.map((row) => ({ id: row.id, rank: topRankById.get(row.id)! })),
  };
  const logId = one<{ id: number }>(
    scope.sql,
    "INSERT INTO search_log (agent_id, query, sort, results, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
    scope.agent.id,
    session.query,
    session.sort,
    JSON.stringify(shownPage),
    scope.now,
  )!.id;
  const searchId = session.id ?? logId;
  if (session.id === undefined && offset + limit < ordered.length) {
    run(scope.sql, "INSERT INTO meta (key, value) VALUES (?, ?)", `${SEARCH_CURSOR_PREFIX}${searchId}`, JSON.stringify(ordered));
  }
  const shownPerConversation = new Map<number, number>();
  for (const row of shown) shownPerConversation.set(row.conversation_id, (shownPerConversation.get(row.conversation_id) ?? 0) + 1);
  for (const [conversationId, count] of shownPerConversation) bumpUsefulness(scope, conversationId, "shown", count);
  const nextOffset = offset + limit;
  return {
    ...(visibleTop.length ? { top: visibleTop.map((row) => formatResult(scope, row, snippetById.get(row.id), parsed.include, detail)) } : {}),
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
  run(
    scope.sql,
    "DELETE FROM meta WHERE key GLOB ? AND NOT EXISTS (SELECT 1 FROM search_log WHERE id = CAST(substr(meta.key, ?) AS INTEGER) AND created_at >= ?)",
    `${SEARCH_CURSOR_PREFIX}*`,
    SEARCH_CURSOR_PREFIX.length + 1,
    scope.now - SEARCH.cursorTtlMs,
  );

  if (args.cursor) {
    const { searchId, offset } = decodeCursor(args.cursor);
    const log = one<{ query: string; sort: SortOrder; created_at: number }>(
      scope.sql,
      "SELECT query, sort, created_at FROM search_log WHERE id = ? AND agent_id = ?",
      searchId,
      scope.agent.id,
    );
    const snapshot = one<{ value: string }>(scope.sql, "SELECT value FROM meta WHERE key = ?", `${SEARCH_CURSOR_PREFIX}${searchId}`);
    if (!log || !snapshot || scope.now - log.created_at > SEARCH.cursorTtlMs) {
      throw new ToolError("this cursor expired (cursors last 10 minutes); run the search again");
    }
    return page(scope, JSON.parse(snapshot.value), offset, limit, parseQuery(log.query), detail, { id: searchId, query: log.query, sort: log.sort });
  }

  const query = args.query?.trim() ?? "";
  const parsed = parseQuery(query);
  if (!parsed.include.length && !parsed.exclude.length && !parsed.modifiers.length) {
    throw new ToolError("query is empty; describe the problem in words, or use modifiers such as in:#deploys or from:@ian.m");
  }
  const sort = args.sort ?? "relevant";
  const searcher: Searcher = { privateIds: privateConversationIds(scope), selfIds: [scope.agent.id] };
  const tuning = searchTuning(scope);
  const ordered = await orderedIds(scope, parsed, sort, searcher, tuning);
  const top = sort === "recent" ? await topForRecent(scope, parsed, ordered, searcher, tuning) : undefined;
  return page(scope, ordered, 0, limit, parsed, detail, { query, sort }, top);
}

export interface ViewerSearch {
  ordered: number[];
  top?: number[];
  terms: FreeTerm[];
}

export async function searchAsViewer(scope: Scope, searcher: Searcher, query: string, sort: SortOrder): Promise<ViewerSearch> {
  const parsed = parseQuery(query.trim());
  if (!parsed.include.length && !parsed.exclude.length && !parsed.modifiers.length) {
    throw new ToolError("Search for at least one word, or use a modifier such as in:#deploys or from:@ian.m.");
  }
  const tuning = searchTuning(scope);
  const ordered = await orderedIds(scope, parsed, sort, searcher, tuning);
  const top = sort === "recent" ? await topForRecent(scope, parsed, ordered, searcher, tuning) : undefined;
  return { ordered, top, terms: parsed.include };
}
