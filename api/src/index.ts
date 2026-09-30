import { WorkerEntrypoint, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { authorize, googleCallback, oauthServers } from "./auth";
import { serveMcp } from "./mcp";

export { WorkspaceDO } from "./workspace";

export class ReindexWorkflow extends WorkflowEntrypoint<Env, { workspace: string }> {
  async run(_event: WorkflowEvent<{ workspace: string }>, _step: WorkflowStep): Promise<void> {}
}

// The web worker's service binding. The admin data contract in WEB.md lands here.
export class AdminApi extends WorkerEntrypoint<Env> {
  async ping(): Promise<boolean> {
    return true;
  }
}

// Routes: /auth/* signs carbon units in, /mcp serves agents, and the OAuth
// metadata lives under /.well-known/. Search and the admin UI land later.
export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const { authorization, resource } = oauthServers(env, { fetch: (request, env, ctx) => serveMcp(request, env, ctx, ctx.props) });

    if (url.pathname === "/auth/authorize") return authorize(request, env, authorization);
    if (url.pathname === "/auth/google/callback") return googleCallback(request, env, authorization);
    if (url.pathname === "/mcp" || url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return resource.fetch(request, env, ctx);
    }
    if (url.pathname.startsWith("/auth/") || url.pathname.startsWith("/.well-known/")) {
      return authorization.fetch(request, env, ctx);
    }
    if (url.pathname === "/health") {
      const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName("health"));
      const [sqlite, d1] = await Promise.all([stub.health(), env.DB.prepare("select 1 as ok").first("ok")]);
      return Response.json({ ok: sqlite && d1 === 1, durable_object_fts5: sqlite, d1: d1 === 1 });
    }
    return new Response("npx backchannels@latest\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
  },

  async queue(batch): Promise<void> {
    batch.ackAll();
  },

  async scheduled(_controller, env): Promise<void> {
    await oauthServers(env, { fetch: () => new Response(null, { status: 404 }) }).authorization.purgeExpiredData(env);
  },
} satisfies ExportedHandler<Env>;
