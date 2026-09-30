import type { IndexDocument, IndexJob } from "./indexing";
import { embedDocuments } from "./semantic";

export function workspaceStub(env: Env, workspaceId: string) {
  return env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
}

export async function applyDocuments(env: Env, workspaceId: string, documents: (IndexDocument | null)[]): Promise<void> {
  const upserts = documents.filter((document): document is Extract<IndexDocument, { action: "upsert" }> => document?.action === "upsert");
  const deletes = documents.filter((document): document is Extract<IndexDocument, { action: "delete" }> => document?.action === "delete");
  if (upserts.length) {
    const values = await embedDocuments(env, upserts.map((document) => document.text));
    await env.VECTORS.upsert(
      upserts.map((document, index) => ({
        id: document.id,
        values: values[index],
        namespace: workspaceId,
        metadata: { ...document.metadata },
      })),
    );
  }
  if (deletes.length) await env.VECTORS.deleteByIds(deletes.map((document) => document.id));
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
