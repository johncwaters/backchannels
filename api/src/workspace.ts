import { DurableObject } from "cloudflare:workers";
import { lookup, updateProfile } from "./agents";
import {
  createChannel,
  inviteToChannel,
  joinChannel,
  leaveChannel,
  listChannels,
  startChat,
  updateChannel,
} from "./conversations";
import type { ConversationSort, DirectoryKind, Scope as AdminScope } from "./admin";
import { adminList, adminRead, adminSearch, type AdminContext } from "./adminData";
import { checkInbox, getNotificationPrefs, markRead, setNotificationPrefs } from "./inbox";
import { LIMITS, RATE_LIMITS } from "./limits";
import { deleteMessage, editMessage, followThread, pin, react, readMessages, save, sendMessage } from "./messages";
import { MIGRATIONS } from "./schema";
import { searchMessages } from "./search";
import { fullHandle, ownerPart } from "./ids";
import { ToolError, one, run, type AgentRow, type Scope } from "./store";

// Tools served by the workspace object. Each runs in one transaction.
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
};

export interface ToolOutcome {
  error?: string;
  output?: Record<string, unknown>;
}

// One per workspace (DATA.md, Durable Object). Everything inside a workspace lives here.

export interface NewAgent {
  id: string;
  agentName: string;
  description: string;
  ownerSub: string;
  ownerEmail: string;
  ownerName: string;
}

export interface WorkspaceIdentity {
  workspaceId: string;
  domain: string;
}

export interface ToolCaller extends WorkspaceIdentity {
  agentId: string;
  grantId: string;
  ownerName: string;
}

export interface AdminCaller {
  sub: string;
  grantId: string;
}

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

  async registerAgent(agent: NewAgent, identity: WorkspaceIdentity, grantId: string): Promise<string> {
    const now = Date.now();
    this.rememberWorkspace(identity);
    const owner = ownerPart(agent.ownerEmail);
    return this.ctx.storage.transactionSync(() => {
      let agentName = agent.agentName;
      for (let n = 2; one(this.sql, "SELECT 1 FROM agents WHERE handle = ?", fullHandle(owner, agentName)); n++) {
        const suffix = `-${n}`;
        agentName = agent.agentName.slice(0, LIMITS.handleLength - suffix.length) + suffix;
      }
      const handle = fullHandle(owner, agentName);
      run(
        this.sql,
        `INSERT INTO agents (id, handle, name, description, owner_sub, owner_email, owner_name, created_at, last_active_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        agent.id,
        handle,
        agentName,
        agent.description,
        agent.ownerSub,
        agent.ownerEmail,
        agent.ownerName,
        now,
        now,
      );
      run(this.sql, "UPDATE agents SET owner_email = ?, owner_name = ? WHERE owner_sub = ?", agent.ownerEmail, agent.ownerName, agent.ownerSub);
      this.audit(grantId, null, "register_agent");
      return handle;
    });
  }

  // Runs one tool for an agent the worker has already authenticated.
  async tool(name: string, caller: ToolCaller, args: Record<string, unknown>): Promise<ToolOutcome> {
    const handler = TOOLS[name];
    if (!handler) return { error: `unknown tool ${name}` };
    this.rememberWorkspace(caller);
    const now = Date.now();
    const agent = one<AgentRow>(this.sql, "SELECT * FROM agents WHERE id = ? AND revoked_at IS NULL", caller.agentId);
    if (!agent) return { error: "agent key not valid for this sign-in; recover it from memory or call register_agent" };

    run(this.sql, "UPDATE agents SET last_active_at = ? WHERE id = ? AND last_active_at < ?", now, agent.id, now - 60_000);
    if (caller.ownerName && caller.ownerName !== agent.owner_name) {
      run(this.sql, "UPDATE agents SET owner_name = ? WHERE owner_sub = ?", caller.ownerName, agent.owner_sub);
      agent.owner_name = caller.ownerName;
    }
    this.audit(caller.grantId, agent.id, name);
    const limited = this.takeTokens(name, caller, now);
    if (limited) return { error: limited };
    try {
      const output = this.ctx.storage.transactionSync(() => handler({ sql: this.sql, now, agent, webUrl: this.env.WEB_URL }, args as never));
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

  async adminRead(caller: AdminCaller, options: { conversation: string; before?: number; limit?: number }) {
    return adminRead(this.adminContext(caller), options);
  }

  async adminSearch(caller: AdminCaller, options: { query: string; scope: AdminScope; cursor?: string }) {
    return adminSearch(this.adminContext(caller), options);
  }

  private adminContext(caller: AdminCaller): AdminContext {
    return {
      sql: this.sql,
      now: Date.now(),
      sub: caller.sub,
      audit: (tool, conversationId) => this.audit(caller.grantId, null, tool, conversationId ?? null),
    };
  }

  // Token buckets (BUILD.md, Starting limits). Returns an error with a retry time, or null.
  private takeTokens(tool: string, caller: ToolCaller, now: number): string | null {
    const limits = RATE_LIMITS[tool] ?? [];
    const buckets = limits.map((limit) => {
      const key = `${limit.bucket}:${limit.per === "agent" ? caller.agentId : caller.grantId}`;
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
