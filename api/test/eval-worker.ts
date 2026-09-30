import worker from "../src/index";
import { serveMcp } from "../src/mcp";
import { vectorId } from "../src/search/indexing";

export { AdminApi, AdminClientsDO, ReindexWorkflow, WorkspaceDO } from "../src/index";

const EVAL_WORKSPACE_ID = "ws_evalsuite";
const EVAL_DOMAIN = "eval.example";
const REINDEX_PAGE = 1000;
const MCP_ROUTE = /^\/eval\/([a-z0-9][a-z0-9-]{0,39})\/mcp$/;

async function ensureCarbonUnit(env: Env, who: string): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO workspaces (id, domain, name, created_at) VALUES (?, ?, ?, ?)").bind(
      EVAL_WORKSPACE_ID,
      EVAL_DOMAIN,
      EVAL_DOMAIN,
      now,
    ),
    env.DB.prepare(
      "INSERT OR IGNORE INTO carbon_units (sub, workspace_id, email, name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(`eval-${who}`, EVAL_WORKSPACE_ID, `${who}@${EVAL_DOMAIN}`, `${who} (eval)`, now, now),
  ]);
}

function workspace(env: Env) {
  return env.WORKSPACE.get(env.WORKSPACE.idFromName(EVAL_WORKSPACE_ID));
}

async function purgeVectors(env: Env): Promise<Response> {
  let afterMessageId = 0;
  let deleted = 0;
  for (;;) {
    const batch = await workspace(env).reindexBatch(afterMessageId, REINDEX_PAGE);
    const ids = batch.jobs.map((job) => vectorId(EVAL_WORKSPACE_ID, job.conv, job.seq, job.kind));
    if (ids.length) await env.VECTORS.deleteByIds(ids);
    deleted += ids.length;
    if (batch.lastId === null) return Response.json({ deleted });
    afterMessageId = batch.lastId;
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const mcp = MCP_ROUTE.exec(url.pathname);
    if (mcp) {
      const who = mcp[1];
      await ensureCarbonUnit(env, who);
      const auth = { sub: `eval-${who}`, email: `${who}@${EVAL_DOMAIN}`, workspace_id: EVAL_WORKSPACE_ID, grant_id: `eval-${who}` };
      return serveMcp(new Request(new URL("/mcp", request.url), request), env, ctx, auth);
    }
    if (url.pathname === "/eval/reindex" && request.method === "POST") {
      const instance = await env.REINDEX.create({ params: { workspace: EVAL_WORKSPACE_ID } });
      return Response.json({ id: instance.id });
    }
    if (url.pathname === "/eval/purge-vectors" && request.method === "POST") return purgeVectors(env);
    return worker.fetch(request, env, ctx);
  },
  queue: worker.queue,
} satisfies ExportedHandler<Env>;
