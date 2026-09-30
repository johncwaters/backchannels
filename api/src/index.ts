import { WorkerEntrypoint, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type {
  AdminApiRpc,
  AdminResult,
  ConversationSort,
  DirectoryKind,
  AgentSummary,
  HeadlessKey,
  Installation,
  NewHeadlessKey,
  Scope,
  AdminReadOptions,
  AdminSearchOptions,
  AdminSearchPage,
  FileDownload,
  SearchMatch,
  Viewer,
} from "./admin";
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
import { createHeadlessKeyFor, listHeadlessKeysFor, revokeHeadlessAgentFor, revokeHeadlessKeyFor, rotateHeadlessKeyFor } from "./headlessAdmin";
import { listOwnAgentsFor, revokeOwnAgentFor, workspaceFor } from "./agentOwnership";
import { SEMANTIC } from "./search/config";
import { STREAM_ROUTE, openStream } from "./stream";
import type { IndexJob } from "./search/indexing";
import { deployedVersion } from "./version";
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

  async serverVersion(token: string): Promise<AdminResult<string>> {
    const identity = await authenticateAdmin(this.env, this.ctx, token);
    if (!identity) return unauthorized;
    return { ok: true, value: deployedVersion(this.env.CF_VERSION_METADATA) };
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
    return { ok: true, value: { email: row.email, name: row.name, workspaceName: row.workspace_name, isAdmin: row.is_admin === 1 } };
  }

  async listConversations(
    token: string,
    options: { scope: Scope; kind?: DirectoryKind; sort?: ConversationSort; filter?: string; cursor?: string },
  ) {
    const identity = await authenticateAdmin(this.env, this.ctx, token);
    if (!identity) return unauthorized;
    return workspaceFor(this.env, identity).adminList(caller(identity), options);
  }

  async readConversation(token: string, options: AdminReadOptions) {
    const identity = await authenticateAdmin(this.env, this.ctx, token);
    if (!identity) return unauthorized;
    return workspaceFor(this.env, identity).adminRead(caller(identity), options);
  }

  async markRead(token: string, options: { conversation: string; thread?: number; upToSeq: number }) {
    const identity = await authenticateAdmin(this.env, this.ctx, token);
    if (!identity) return unauthorized;
    return workspaceFor(this.env, identity).adminMarkRead(caller(identity), options);
  }

  async listPins(token: string, options: { conversation: string }) {
    const identity = await authenticateAdmin(this.env, this.ctx, token);
    if (!identity) return unauthorized;
    return workspaceFor(this.env, identity).adminPins(caller(identity), options);
  }

  async downloadFile(token: string, options: { conversation: string; file: string }): Promise<AdminResult<FileDownload>> {
    const identity = await authenticateAdmin(this.env, this.ctx, token);
    if (!identity) return unauthorized;
    return workspaceFor(this.env, identity).adminFile(caller(identity), options);
  }

  async search(token: string, options: AdminSearchOptions): Promise<AdminResult<AdminSearchPage>> {
    const identity = await authenticateAdmin(this.env, this.ctx, token);
    if (!identity) return unauthorized;
    const found = await workspaceFor(this.env, identity).adminSearch(caller(identity), options);
    if (!found.ok) return found;
    type RpcSearchMatch = Omit<SearchMatch, "ranges"> & { ranges: number[][] };
    const copyRanges = (match: RpcSearchMatch): SearchMatch => ({
      ...match,
      ranges: match.ranges.map(([start, end]): [number, number] => [start, end]),
    });
    const { matches, top, ...rest } = found.value;
    return { ok: true, value: { ...rest, matches: matches.map(copyRanges), ...(top ? { top: top.map(copyRanges) } : {}) } };
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

  async listHeadlessKeys(
    token: string,
    options: { cursor?: string },
  ): Promise<AdminResult<{ keys: HeadlessKey[]; agents: AgentSummary[]; nextCursor?: string }>> {
    const identity = await authenticateAdmin(this.env, this.ctx, token);
    if (!identity) return unauthorized;
    return listHeadlessKeysFor(this.env, identity, options);
  }

  async createHeadlessKey(
    token: string,
    options: { label: string; suggestedName: string; expiresInDays: number },
  ): Promise<AdminResult<NewHeadlessKey>> {
    const identity = await authenticateAdmin(this.env, this.ctx, token);
    if (!identity) return unauthorized;
    return createHeadlessKeyFor(this.env, identity, options);
  }

  async rotateHeadlessKey(token: string, options: { keyId: string }): Promise<AdminResult<NewHeadlessKey>> {
    const identity = await authenticateAdmin(this.env, this.ctx, token);
    if (!identity) return unauthorized;
    return rotateHeadlessKeyFor(this.env, identity, options);
  }

  async revokeHeadlessKey(token: string, options: { keyId: string }): Promise<AdminResult<null>> {
    const identity = await authenticateAdmin(this.env, this.ctx, token);
    if (!identity) return unauthorized;
    return revokeHeadlessKeyFor(this.env, identity, options);
  }

  async revokeHeadlessAgent(token: string, options: { handle: string }): Promise<AdminResult<null>> {
    const identity = await authenticateAdmin(this.env, this.ctx, token);
    if (!identity) return unauthorized;
    return revokeHeadlessAgentFor(this.env, identity, options);
  }

  async listOwnAgents(token: string): Promise<AdminResult<{ agents: AgentSummary[] }>> {
    const identity = await authenticateAdmin(this.env, this.ctx, token);
    if (!identity) return unauthorized;
    return listOwnAgentsFor(this.env, identity);
  }

  async revokeOwnAgent(token: string, options: { handle: string }): Promise<AdminResult<null>> {
    const identity = await authenticateAdmin(this.env, this.ctx, token);
    if (!identity) return unauthorized;
    return revokeOwnAgentFor(this.env, identity, options);
  }
}

const caller = (identity: AdminIdentity) => ({ sub: identity.sub, grantId: identity.grantId, workspaceId: identity.workspaceId });

// Routes: /auth/* signs carbon units in, /mcp serves agents, and the OAuth
// metadata lives under /.well-known/. Search and the admin UI land later.
export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const { authorization, resource } = oauthServers(env);
    if (url.pathname.startsWith("/auth/")) await seedPinnedClientDocuments();

    if (url.pathname === "/auth/authorize") return authorize(request, env, authorization);
    if (url.pathname === "/auth/google/callback") return googleCallback(request, env, authorization);
    const streamWorkspaceId = STREAM_ROUTE.exec(url.pathname)?.[1];
    if (streamWorkspaceId) return openStream(request, env, streamWorkspaceId);
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
