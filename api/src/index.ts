import { WorkerEntrypoint, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { AdminApiRpc, AdminResult, ConversationSort, DirectoryKind, Scope, SearchMatch, Viewer } from "./admin";
import {
  adminSignInUrl,
  authenticateAdmin,
  exchangeAdminCode,
  refreshAdminSession,
  revokeAdminSession,
  type AdminIdentity,
} from "./adminSession";
import { authorize, googleCallback, oauthServers } from "./auth";
import { findViewer } from "./directory";

export { AdminClientsDO } from "./adminClients";
export { WorkspaceDO } from "./workspace";

export class ReindexWorkflow extends WorkflowEntrypoint<Env, { workspace: string }> {
  async run(_event: WorkflowEvent<{ workspace: string }>, _step: WorkflowStep): Promise<void> {}
}

const unauthorized = { ok: false, error: "unauthorized" } as const;

// The web worker's service binding (WEB.md, Admin data contract).
export class AdminApi extends WorkerEntrypoint<Env> implements AdminApiRpc {
  async ping(): Promise<boolean> {
    return true;
  }

  adminSignInUrl(input: { redirectUri: string; state: string; codeChallenge: string }) {
    return adminSignInUrl(this.env, input);
  }

  exchangeAdminCode(input: { code: string; codeVerifier: string; redirectUri: string }) {
    return exchangeAdminCode(this.env, this.ctx, input);
  }

  refreshAdminSession(input: { refreshToken: string; redirectUri: string }) {
    return refreshAdminSession(this.env, this.ctx, input);
  }

  revokeAdminSession(input: { refreshToken: string; redirectUri: string }) {
    return revokeAdminSession(this.env, this.ctx, input);
  }

  async viewer(token: string): Promise<AdminResult<Viewer>> {
    const identity = await authenticateAdmin(this.env, this.ctx, token);
    if (!identity) return unauthorized;
    const row = await findViewer(this.env.DB, identity.sub, identity.workspaceId);
    if (!row) return unauthorized;
    return { ok: true, value: { email: row.email, name: row.name, workspaceName: row.workspace_name } };
  }

  async listConversations(
    token: string,
    options: { scope: Scope; kind?: DirectoryKind; sort?: ConversationSort; filter?: string; cursor?: string },
  ) {
    const identity = await authenticateAdmin(this.env, this.ctx, token);
    if (!identity) return unauthorized;
    return this.workspace(identity).adminList(caller(identity), options);
  }

  async readConversation(token: string, options: { conversation: string; before?: number; limit?: number }) {
    const identity = await authenticateAdmin(this.env, this.ctx, token);
    if (!identity) return unauthorized;
    return this.workspace(identity).adminRead(caller(identity), options);
  }

  async search(
    token: string,
    options: { query: string; scope: Scope; cursor?: string },
  ): Promise<AdminResult<{ matches: SearchMatch[]; nextCursor?: string }>> {
    const identity = await authenticateAdmin(this.env, this.ctx, token);
    if (!identity) return unauthorized;
    const found = await this.workspace(identity).adminSearch(caller(identity), options);
    if (!found.ok) return found;
    const matches = found.value.matches.map((match) => ({
      ...match,
      ranges: match.ranges.map(([start, end]): [number, number] => [start, end]),
    }));
    return { ok: true, value: { ...found.value, matches } };
  }

  private workspace(identity: AdminIdentity) {
    return this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(identity.workspaceId));
  }
}

const caller = (identity: AdminIdentity) => ({ sub: identity.sub, grantId: identity.grantId });

// Routes: /auth/* signs carbon units in, /mcp serves agents, and the OAuth
// metadata lives under /.well-known/. Search and the admin UI land later.
export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const { authorization, resource } = oauthServers(env);

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
    await oauthServers(env).authorization.purgeExpiredData(env);
  },
} satisfies ExportedHandler<Env>;
