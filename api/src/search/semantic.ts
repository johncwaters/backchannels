import { SEMANTIC } from "./config";
import { parseVectorId, type VectorKind } from "./indexing";

export interface VectorFilter {
  conversationIds?: number[];
  authorIds?: string[];
  dayFrom?: number;
  dayBefore?: number;
}

export interface VectorHit {
  conversationId: number;
  seq: number;
  kind: VectorKind;
  score: number;
}

type MetadataFilter = VectorizeVectorMetadataFilter;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
  return chunks;
}

export async function embedDocuments(env: Env, texts: string[]): Promise<number[][]> {
  const vectors: number[][] = [];
  for (const batch of chunk(texts, SEMANTIC.embedBatchSize)) {
    const output = await env.AI.run(SEMANTIC.embeddingModel, { documents: batch });
    if (!output.data || output.data.length !== batch.length) throw new Error("embedding model returned the wrong number of vectors");
    vectors.push(...output.data);
  }
  return vectors;
}

export async function embedQuery(env: Env, query: string): Promise<number[]> {
  const output = await env.AI.run(SEMANTIC.embeddingModel, { queries: [query], instruction: SEMANTIC.queryInstruction });
  const vector = output.data?.[0];
  if (!vector) throw new Error("embedding model returned no query vector");
  return vector;
}

function sharedFilter(filter: VectorFilter): MetadataFilter {
  const metadata: MetadataFilter = {};
  if (filter.authorIds) metadata.author = { $in: filter.authorIds };
  if (filter.dayFrom !== undefined || filter.dayBefore !== undefined) {
    metadata.day = {
      ...(filter.dayFrom !== undefined ? { $gte: filter.dayFrom } : {}),
      ...(filter.dayBefore !== undefined ? { $lt: filter.dayBefore } : {}),
    };
  }
  return metadata;
}

function visibilityFilters(filter: VectorFilter, privateConversationIds: number[]): MetadataFilter[] {
  const shared = sharedFilter(filter);
  const requested = filter.conversationIds ? new Set(filter.conversationIds) : null;
  const privateIds = requested ? privateConversationIds.filter((id) => requested.has(id)) : privateConversationIds;
  const visiblePrivateIds = new Set(privateIds);
  const includesPublic = !requested || [...requested].some((id) => !visiblePrivateIds.has(id));
  const publicFilter: MetadataFilter = requested
    ? { ...shared, vis: "pub", ch: { $in: [...requested] } }
    : { ...shared, vis: "pub" };
  const privateFilters = chunk(privateIds, SEMANTIC.privateIdsPerQuery).map((ids) => ({ ...shared, ch: { $in: ids } }));
  return includesPublic ? [publicFilter, ...privateFilters] : privateFilters;
}

export async function searchVectors(
  env: Env,
  workspaceId: string,
  query: string,
  filter: VectorFilter,
  privateConversationIds: number[],
): Promise<VectorHit[]> {
  const vector = await embedQuery(env, query);
  const responses = await Promise.all(
    visibilityFilters(filter, privateConversationIds).map((metadataFilter) =>
      env.VECTORS.query(vector, { topK: SEMANTIC.topK, namespace: workspaceId, filter: metadataFilter, returnMetadata: "none" }),
    ),
  );
  return responses
    .flatMap((response) => response.matches)
    .flatMap((match) => {
      const parsed = parseVectorId(match.id);
      return parsed ? [{ ...parsed, score: match.score }] : [];
    })
    .sort((a, b) => b.score - a.score);
}

export async function crossEncoderScores(env: Env, query: string, texts: string[]): Promise<number[]> {
  const input = {
    query,
    contexts: texts.map((text) => ({ text: text.slice(0, SEMANTIC.rerankTextChars) })),
    top_k: texts.length,
  } as Ai_Cf_Baai_Bge_Reranker_Base_Input;
  const output = await env.AI.run(SEMANTIC.rerankModel, input);
  const scores = new Array<number>(texts.length).fill(0);
  for (const item of output.response ?? []) {
    if (item.id !== undefined && item.score !== undefined) scores[item.id] = item.score;
  }
  return scores;
}

export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}
