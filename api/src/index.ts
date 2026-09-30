import { WorkerEntrypoint, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { AdminApiRpc, AdminResult, ConversationSort, DirectoryKind, Installation, Scope, SearchMatch, Viewer } from "./admin";
import {
  adminSignInUrl,
  authenticateAdmin,
  exchangeAdminCode,
  listInstallations,
  refreshAdminSession,
  revokeAdminSession,
  revokeInstallation,
  type AdminIdentity,
} from "./adminSession";
import { authorize, googleCallback, oauthServers } from "./auth";
import { seedPinnedClientDocuments } from "./pinnedClients";
import { findViewer } from "./directory";
import { headlessBearer, serveHeadless } from "./headless";
import { SEMANTIC } from "./search/config";
import type { IndexJob } from "./search/indexing";
import { DEAD_LETTER_QUEUE_NAME, applyDocuments, logDeadJobs, processIndexBatch, recordDeadJobs, workspaceStub } from "./search/vectors";

export { AdminClientsDO } from "./adminClients";
export { WorkspaceDO } from "./workspace";

export class ReindexWorkflow extends WorkflowEntrypoint<Env, { workspace: string }> {
  async run(event: WorkflowEvent<{ workspace: string }>, step: WorkflowStep): Promise<void> {
    const workspaceId = event.payload.workspace;
    const workspace = workspaceStub(this.env, workspaceId);
    let afterMessageId = 0;
    for (;;) {
      const lastId = await step.do(`messages after ${afterMessageId}`, async () => {
        const batch = await workspace.reindexBatch(afterMessageId, SEMANTIC.reindexBatchSize);
        const jobs = batch.jobs.map((job) => ({ ...job, ws: workspaceId }) as IndexJob);
        await applyDocuments(this.env, workspaceId, await workspace.indexDocuments(workspaceId, jobs));
        return batch.lastId;
      });
      if (lastId === null) return;
      afterMessageId = lastId;
    }
  }
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
    return workspaceFor(this.env, identity).adminList(caller(identity), options);
  }

  async readConversation(token: string, options: { conversation: string; before?: number; limit?: number }) {
    const identity = await authenticateAdmin(this.env, this.ctx, token);
    if (!identity) return unauthorized;
    return workspaceFor(this.env, identity).adminRead(caller(identity), options);
  }

  async search(
    token: string,
    options: { query: string; scope: Scope; cursor?: string },
  ): Promise<AdminResult<{ matches: SearchMatch[]; nextCursor?: string }>> {
    const identity = await authenticateAdmin(this.env, this.ctx, token);
    if (!identity) return unauthorized;
    const found = await workspaceFor(this.env, identity).adminSearch(caller(identity), options);
    if (!found.ok) return found;
    const matches = found.value.matches.map((match) => ({
      ...match,
      ranges: match.ranges.map(([start, end]): [number, number] => [start, end]),
    }));
    return { ok: true, value: { ...found.value, matches } };
  }

  async listInstallations(token: string): Promise<AdminResult<{ installations: Installation[] }>> {
    const identity = await authenticateAdmin(this.env, this.ctx, token);
    if (!identity) return unauthorized;
    return listInstallations(this.env, identity);
  }

  async revokeInstallation(token: string, options: { grantId: string }): Promise<AdminResult<null>> {
    const identity = await authenticateAdmin(this.env, this.ctx, token);
    if (!identity) return unauthorized;
    return revokeInstallation(this.env, identity, options);
  }
}

// Module scope, not a method: RPC exposes every method, TypeScript `private` included.
function workspaceFor(env: Env, identity: AdminIdentity) {
  return env.WORKSPACE.get(env.WORKSPACE.idFromName(identity.workspaceId));
}

const caller = (identity: AdminIdentity) => ({ sub: identity.sub, grantId: identity.grantId });

// Routes: /auth/* signs carbon units in, /mcp serves agents, and the OAuth
// metadata lives under /.well-known/. Search and the admin UI land later.
export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const { authorization, resource } = oauthServers(env);
    if (url.pathname.startsWith("/auth/")) await seedPinnedClientDocuments();

    if (url.pathname === "/auth/authorize") return authorize(request, env, authorization);
    if (url.pathname === "/auth/google/callback") return googleCallback(request, env, authorization);
    const headlessKey = url.pathname === "/mcp" ? headlessBearer(request) : null;
    if (headlessKey) return serveHeadless(request, env, ctx, headlessKey);
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

  async queue(batch, env): Promise<void> {
    const jobs = batch as MessageBatch<IndexJob>;
    if (batch.queue === DEAD_LETTER_QUEUE_NAME) await recordDeadJobs(jobs, env);
    else await processIndexBatch(jobs, env);
  },

  async scheduled(_controller, env): Promise<void> {
    await oauthServers(env).authorization.purgeExpiredData(env);
    await logDeadJobs(env);
  },
} satisfies ExportedHandler<Env>;
