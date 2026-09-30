import type { IndexDocument, IndexJob } from "./indexing";
import { embedDocuments } from "./semantic";

export function workspaceStub(env: Env, workspaceId: string) {
  return env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
}

const VECTORIZE_MAX_DELETE_IDS = 100;
const VECTORIZE_UPSERT_BATCH = 500;

export function inChunks<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
  return chunks;
}

export async function deleteVectors(env: Env, ids: string[]): Promise<void> {
  for (const chunk of inChunks(ids, VECTORIZE_MAX_DELETE_IDS)) await env.VECTORS.deleteByIds(chunk);
}

export async function applyDocuments(env: Env, workspaceId: string, documents: (IndexDocument | null)[]): Promise<void> {
  const upserts = documents.filter((document): document is Extract<IndexDocument, { action: "upsert" }> => document?.action === "upsert");
  const deletes = documents.filter((document): document is Extract<IndexDocument, { action: "delete" }> => document?.action === "delete");
  for (const chunk of inChunks(upserts, VECTORIZE_UPSERT_BATCH)) {
    const values = await embedDocuments(env, chunk.map((document) => document.text));
    await env.VECTORS.upsert(
      chunk.map((document, index) => ({
        id: document.id,
        values: values[index],
        namespace: workspaceId,
        metadata: { ...document.metadata },
      })),
    );
  }
  await deleteVectors(env, deletes.map((document) => document.id));
}

export async function processIndexBatch(batch: MessageBatch<IndexJob>, env: Env): Promise<void> {
  const byWorkspace = new Map<string, Message<IndexJob>[]>();
  for (const message of batch.messages) {
    byWorkspace.set(message.body.ws, [...(byWorkspace.get(message.body.ws) ?? []), message]);
  }
  await Promise.all(
    [...byWorkspace.entries()].map(async ([workspaceId, messages]) => {
      try {
        const documents = await workspaceStub(env, workspaceId).indexDocuments(
          workspaceId,
          messages.map((message) => message.body),
        );
        await applyDocuments(env, workspaceId, documents);
        for (const message of messages) message.ack();
      } catch (error) {
        console.error(`indexing failed for ${workspaceId}; retrying ${messages.length} jobs`, error);
        for (const message of messages) message.retry();
      }
    }),
  );
}

export const DEAD_LETTER_QUEUE_NAME = "backchannels-index-dlq";

export async function recordDeadJobs(batch: MessageBatch<IndexJob>, env: Env): Promise<void> {
  const deadAt = Date.now();
  await env.DB.batch(
    batch.messages.map((message) =>
      env.DB.prepare("INSERT INTO dead_index_jobs (workspace_id, job, dead_at) VALUES (?, ?, ?)").bind(
        message.body.ws,
        JSON.stringify(message.body),
        deadAt,
      ),
    ),
  );
  console.error(`${batch.messages.length} index jobs failed every retry; recorded in dead_index_jobs, run the reindex workflow for their workspaces`);
  batch.ackAll();
}

export async function logDeadJobs(env: Env): Promise<void> {
  const summary = await env.DB.prepare("SELECT count(*) AS dead, min(dead_at) AS oldest, count(DISTINCT workspace_id) AS workspaces FROM dead_index_jobs").first<{
    dead: number;
    oldest: number | null;
    workspaces: number;
  }>();
  if (!summary?.dead) return;
  console.warn(
    `dead index jobs: ${summary.dead} in ${summary.workspaces} workspaces, oldest ${new Date(summary.oldest!).toISOString()}; reindex those workspaces`,
  );
}
