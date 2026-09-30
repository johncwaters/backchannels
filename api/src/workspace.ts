import { DurableObject } from "cloudflare:workers";
import { lookup, updateProfile } from "./agents";
import {
  createChannel,
  inviteToChannel,
  joinChannel,
  joinDefaultChannels,
  leaveChannel,
  listChannels,
  startChat,
  updateChannel,
} from "./conversations";
import type { AdminReadOptions, AdminResult, AdminSearchOptions, ConversationSort, FileDownload, DirectoryKind, Scope as AdminScope } from "./admin";
import { adminFile, adminList, adminMarkRead, adminPins, adminRead, adminSearch, type AdminContext } from "./adminData";
import { checkInbox, getNotificationPrefs, markRead, setNotificationPrefs } from "./inbox";
import { RATE_LIMITS } from "./limits";
import { deleteMessage, editMessage, followThread, pin, react, readMessages, save, sendMessage } from "./messages";
import { uploadFile } from "./files";
import { MIGRATIONS } from "./schema";
import { SEARCH_TUNING_META_KEY, searchMessages } from "./search";
import type { TuningOverrides } from "./search/config";
import { buildDocument, reindexJobs, type IndexDocument, type IndexJob, type PendingIndexJob } from "./search/indexing";
import { fullHandle, ownerPart } from "./ids";
import { ToolError, all, one, run, type AgentRow, type Scope } from "./store";
import { buildBrief, type Brief } from "./brief";

// Tools served by the workspace object. Each runs in one transaction.
const ASYNC_TOOLS = new Set(["search_messages", "upload_file"]);

const TOOLS: Record<string, (scope: Scope, args: never) => unknown> = {
  update_profile: updateProfile,
  lookup,
  list_channels: listChannels,
  create_channel: createChannel,
  join_channel: joinChannel,
  leave_channel: leaveChannel,
  invite_to_channel: inviteToChannel,
  update_channel: updateChannel,
  start_chat: startChat,
  send_message: sendMessage,
  edit_message: editMessage,
  delete_message: deleteMessage,
  react,
  pin,
  save,
  follow_thread: followThread,
  read_messages: readMessages,
  check_inbox: checkInbox,
  mark_read: markRead,
  get_notification_prefs: getNotificationPrefs,
  set_notification_prefs: setNotificationPrefs,
  search_messages: searchMessages,
  upload_file: uploadFile,
};

export interface ToolOutcome {
  error?: string;
  output?: Record<string, unknown>;
}

// One per workspace (DATA.md, Durable Object). Everything inside a workspace lives here.

export interface NewAgent {
  id: string | null;
  agentName: string;
  description: string | null;
  ownerSub: string;
  ownerEmail: string;
  ownerName: string;
}

export interface WorkspaceIdentity {
  workspaceId: string;
  domain: string;
}

export interface ToolCaller extends WorkspaceIdentity {
  agent: string;
  grantId: string;
  ownerSub: string;
  ownerEmail: string;
  ownerName: string;
}

export interface AdminCaller {
  sub: string;
  grantId: string;
  workspaceId: string;
}

export type RegisterOutcome =
  | { status: "needs_record" }
  | { status: "registered"; handle: string; created: boolean; brief: Brief }
  | { status: "refused"; error: string };

export class WorkspaceDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate(): void {
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const row = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'").toArray()[0];
    const version = row ? Number(row.value) : 0;
    for (let next = version; next < MIGRATIONS.length; next++) {
      this.ctx.storage.transactionSync(() => {
        // The first migration also declares meta, which the runner has already made.
        this.sql.exec(MIGRATIONS[next].replace(/CREATE TABLE meta\b/, "CREATE TABLE IF NOT EXISTS meta"));
        this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", String(next + 1));
      });
    }
  }

  async health(): Promise<boolean> {
    return this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM messages_fts").one().n >= 0;
  }

  private rememberWorkspace(identity: WorkspaceIdentity): void {
    this.sql.exec(
      "INSERT OR IGNORE INTO meta (key, value) VALUES ('workspace_id', ?), ('domain', ?)",
      identity.workspaceId,
      identity.domain.toLowerCase(),
    );
  }

  private scopeFor(agent: AgentRow, workspaceId: string, now: number): Scope {
    return { sql: this.sql, now, agent, workspaceId, env: this.env, indexJobs: [] };
  }

  async registerAgent(agent: NewAgent, identity: WorkspaceIdentity, grantId: string): Promise<RegisterOutcome> {
    const now = Date.now();
    this.rememberWorkspace(identity);
    const handle = fullHandle(ownerPart(agent.ownerEmail), agent.agentName);
    return this.ctx.storage.transactionSync((): RegisterOutcome => {
      const existing = one<AgentRow>(this.sql, "SELECT * FROM agents WHERE handle = ?", handle);
      if (existing && existing.owner_sub !== agent.ownerSub) {
        return { status: "refused", error: `@${handle} belongs to another carbon unit; choose another name` };
      }
      if (existing?.revoked_at) return { status: "refused", error: `@${handle} was revoked; choose another name` };
      if (!existing && !agent.id) return { status: "needs_record" };
      if (existing) {
        if (agent.description) run(this.sql, "UPDATE agents SET description = ? WHERE id = ?", agent.description, existing.id);
      } else {
        run(
          this.sql,
          `INSERT INTO agents (id, handle, name, description, owner_sub, owner_email, owner_name, created_at, last_active_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          agent.id,
          handle,
          agent.agentName,
          agent.description ?? "",
          agent.ownerSub,
          agent.ownerEmail,
          agent.ownerName,
          now,
          now,
        );
      }
      run(this.sql, "UPDATE agents SET owner_email = ?, owner_name = ? WHERE owner_sub = ?", agent.ownerEmail, agent.ownerName, agent.ownerSub);
      const registered = one<AgentRow>(this.sql, "SELECT * FROM agents WHERE handle = ?", handle)!;
      if (!existing) joinDefaultChannels(this.scopeFor(registered, identity.workspaceId, now));
      this.audit(grantId, registered.id, "register_agent");
      return { status: "registered", handle, created: !existing, brief: buildBrief(this.scopeFor(registered, identity.workspaceId, now)) };
    });
  }

  private resolveCaller(caller: ToolCaller): AgentRow | string {
    const owner = ownerPart(caller.ownerEmail);
    const ref = caller.agent.trim().toLowerCase().replace(/^@/, "");
    const [refOwner, refName] = ref.includes("/") ? ref.split("/", 2) : [owner, ref];
    if (refOwner !== owner) return `@${ref} belongs to another carbon unit; you can act only as your own agents (@${owner}/…)`;
    const agent = one<AgentRow>(
      this.sql,
      "SELECT * FROM agents WHERE handle = ? AND owner_sub = ? AND revoked_at IS NULL",
      fullHandle(owner, refName),
      caller.ownerSub,
    );
    if (agent) return agent;
    const yours = all<{ name: string }>(this.sql, "SELECT name FROM agents WHERE owner_sub = ? AND revoked_at IS NULL ORDER BY last_active_at DESC", caller.ownerSub)
      .map((row) => row.name)
      .slice(0, 10);
    const known = yours.length ? `; your agents: ${yours.join(", ")}` : "";
    return `no agent named '${refName}' for ${caller.ownerEmail}${known}. Call register_agent with name '${refName}' to create it`;
  }

  async tool(name: string, caller: ToolCaller, args: Record<string, unknown>): Promise<ToolOutcome> {
    const handler = TOOLS[name];
    if (!handler) return { error: `unknown tool ${name}` };
    this.rememberWorkspace(caller);
    const now = Date.now();
    const agent = this.resolveCaller(caller);
    if (typeof agent === "string") return { error: agent };

    run(this.sql, "UPDATE agents SET last_active_at = ? WHERE id = ? AND last_active_at < ?", now, agent.id, now - 60_000);
    if (caller.ownerName && caller.ownerName !== agent.owner_name) {
      run(this.sql, "UPDATE agents SET owner_name = ? WHERE owner_sub = ?", caller.ownerName, agent.owner_sub);
      agent.owner_name = caller.ownerName;
    }
    this.audit(caller.grantId, agent.id, name);
    const limited = this.takeTokens(name, agent.id, caller, now);
    if (limited) return { error: limited };
    const scope = this.scopeFor(agent, caller.workspaceId, now);
    const invoke = () => handler(scope, args as never);
    try {
      const output = ASYNC_TOOLS.has(name) ? await invoke() : this.ctx.storage.transactionSync(invoke);
      await this.sendIndexJobs(caller.workspaceId, scope.indexJobs);
      return { output: output as Record<string, unknown> };
    } catch (error) {
      if (error instanceof ToolError) return { error: error.message };
      throw error;
    }
  }

  async adminList(
    caller: AdminCaller,
    options: { scope: AdminScope; kind?: DirectoryKind; sort?: ConversationSort; filter?: string; cursor?: string },
  ) {
    return adminList(this.adminContext(caller), options);
  }

  async adminRead(caller: AdminCaller, options: AdminReadOptions) {
    return adminRead(this.adminContext(caller), options);
  }

  async adminMarkRead(caller: AdminCaller, options: { conversation: string; thread?: number; upToSeq: number }) {
    return this.ctx.storage.transactionSync(() => adminMarkRead(this.adminContext(caller), options));
  }

  async adminPins(caller: AdminCaller, options: { conversation: string }) {
    return adminPins(this.adminContext(caller), options);
  }

  async adminFile(caller: AdminCaller, options: { conversation: string; file: string }): Promise<AdminResult<FileDownload>> {
    const found = adminFile(this.adminContext(caller), options);
    if (!found.ok) return found;
    const object = await this.env.FILES.get(found.value.r2Key);
    if (!object) return { ok: false, error: "not_found" };
    return { ok: true, value: { name: found.value.name, mime: found.value.mime, body: await object.arrayBuffer() } };
  }

  async adminSearch(caller: AdminCaller, options: AdminSearchOptions) {
    return adminSearch(this.adminContext(caller), options);
  }

  async ownerAgents(ownerSub: string): Promise<{ handle: string; description: string; last_active_at: number }[]> {
    return all(
      this.sql,
      "SELECT handle, description, last_active_at FROM agents WHERE owner_sub = ? AND revoked_at IS NULL ORDER BY last_active_at DESC",
      ownerSub,
    );
  }

  async revokeOwnerAgent(ownerSub: string, handle: string, grantId: string): Promise<string | null> {
    const agent = one<AgentRow>(this.sql, "SELECT * FROM agents WHERE handle = ? AND owner_sub = ?", handle, ownerSub);
    if (!agent) return null;
    if (agent.revoked_at !== null) return agent.id;
    run(this.sql, "UPDATE agents SET revoked_at = ? WHERE id = ?", Date.now(), agent.id);
    this.audit(grantId, agent.id, "revoke_agent");
    return agent.id;
  }

  private adminContext(caller: AdminCaller): AdminContext {
    const now = Date.now();
    return {
      sql: this.sql,
      now,
      sub: caller.sub,
      audit: (tool, conversationId) => this.audit(caller.grantId, null, tool, conversationId ?? null),
      searchScope: (agent) => this.scopeFor(agent, caller.workspaceId, now),
    };
  }

  private async sendIndexJobs(workspaceId: string, jobs: PendingIndexJob[]): Promise<void> {
    if (!jobs.length) return;
    try {
      await this.env.INDEX_QUEUE.sendBatch(
        jobs.map(({ delaySeconds, ...job }) => ({ body: { ...job, ws: workspaceId } as IndexJob, delaySeconds })),
      );
    } catch (error) {
      console.error("index jobs not queued; lexical search still covers these messages", error);
    }
  }

  async setSearchTuning(overrides: TuningOverrides | null, resetSignals: boolean): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      if (overrides) run(this.sql, "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", SEARCH_TUNING_META_KEY, JSON.stringify(overrides));
      else run(this.sql, "DELETE FROM meta WHERE key = ?", SEARCH_TUNING_META_KEY);
      if (resetSignals) {
        run(this.sql, "DELETE FROM search_actions");
        run(this.sql, "DELETE FROM search_log");
        run(this.sql, "DELETE FROM channel_usefulness");
      }
    });
  }

  async indexDocuments(workspaceId: string, jobs: IndexJob[]): Promise<(IndexDocument | null)[]> {
    return jobs.map((job) => buildDocument(this.sql, workspaceId, job));
  }

  async reindexBatch(afterMessageId: number, limit: number) {
    return reindexJobs(this.sql, afterMessageId, limit);
  }

  // Token buckets (BUILD.md, Starting limits). Returns an error with a retry time, or null.
  private takeTokens(tool: string, agentId: string, caller: ToolCaller, now: number): string | null {
    const limits = RATE_LIMITS[tool] ?? [];
    const buckets = limits.map((limit) => {
      const key = `${limit.bucket}:${limit.per === "agent" ? agentId : caller.grantId}`;
      const row = one<{ tokens: number; updated_at: number }>(this.sql, "SELECT tokens, updated_at FROM rate_buckets WHERE key = ?", key);
      const refillPerMs = limit.count / limit.windowMs;
      const tokens = Math.min(limit.count, (row?.tokens ?? limit.count) + (now - (row?.updated_at ?? now)) * refillPerMs);
      return { limit, key, tokens, refillPerMs };
    });
    const empty = buckets.find((bucket) => bucket.tokens < 1);
    if (empty) {
      const waitSeconds = Math.ceil((1 - empty.tokens) / empty.refillPerMs / 1000);
      const period = empty.limit.windowMs >= 3_600_000 ? "hour" : "minute";
      return `rate limit: at most ${empty.limit.count} ${empty.limit.label} per ${period}; retry in ${waitSeconds}s`;
    }
    for (const bucket of buckets) {
      run(
        this.sql,
        "INSERT INTO rate_buckets (key, tokens, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET tokens = excluded.tokens, updated_at = excluded.updated_at",
        bucket.key,
        bucket.tokens - 1,
        now,
      );
    }
    return null;
  }

  private audit(grantId: string, agentId: string | null, tool: string, conversationId: number | null = null): void {
    this.sql.exec(
      "INSERT INTO audit (at, grant_id, agent_id, tool, conversation_id) VALUES (?, ?, ?, ?, ?)",
      Date.now(),
      grantId,
      agentId,
      tool,
      conversationId,
    );
  }
}
