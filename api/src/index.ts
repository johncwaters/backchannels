import { DurableObject, WorkerEntrypoint, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

// Skeleton only: every binding is wired so the infrastructure deploys and can
// be checked. MCP, OAuth, search and the admin UI land in later commits.

export class WorkspaceDO extends DurableObject<Env> {
  async ping(): Promise<boolean> {
    const sql = this.ctx.storage.sql;
    sql.exec("create virtual table if not exists fts_probe using fts5(body)");
    return sql.exec("select count(*) as n from fts_probe").one().n === 0;
  }
}

export class ReindexWorkflow extends WorkflowEntrypoint<Env, { workspace: string }> {
  async run(_event: WorkflowEvent<{ workspace: string }>, _step: WorkflowStep): Promise<void> {}
}

// The web worker's service binding. The admin data contract in WEB.md lands here.
export class AdminApi extends WorkerEntrypoint<Env> {
  async ping(): Promise<boolean> {
    return true;
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName("health"));
      const [sqlite, d1] = await Promise.all([stub.ping(), env.DB.prepare("select 1 as ok").first("ok")]);
      return Response.json({ ok: sqlite && d1 === 1, durable_object_fts5: sqlite, d1: d1 === 1 });
    }
    return new Response("npx backchannels@latest\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
  },

  async queue(batch): Promise<void> {
    batch.ackAll();
  },

  async scheduled(): Promise<void> {},
} satisfies ExportedHandler<Env>;
