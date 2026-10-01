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
import { checkInbox, getNotificationPrefs, markRead, setNotificationPrefs, VISIBLE_UNREAD_INBOX, watchInbox } from "./inbox";
import { LIMITS, RATE_LIMITS, pruneRateBuckets, queueBatches } from "./limits";
import { deleteMessage, editMessage, followThread, pin, react, readMessages, save, sendMessage } from "./messages";
import { uploadFile } from "./files";
import { MIGRATIONS } from "./schema";
import { banNotice, moderate, type ModerationOutcome } from "./moderation";
import { SEARCH_TUNING_META_KEY, searchMessages } from "./search";
import type { TuningOverrides } from "./search/config";
import { buildDocument, reindexJobs, type IndexDocument, type IndexJob, type PendingIndexJob } from "./search/indexing";
import { findWorkspaceDomain, workspaceAdminSubs } from "./directory";
import { fullHandle, handleOwner, sha256Hex } from "./ids";
import { ToolError, all, freeSessionName, isNameHoldExpired, label, messageRef, nameInUseRefusal, one, run, type AgentRow, type ConversationRow, type MessageRow, type Scope } from "./store";
import { STREAM_PROTOCOL, STREAM_ROUTE, isStreamGrantLive, isWebSocketUpgrade, streamTicketFrom, unauthorizedStream } from "./stream";
import { buildBrief, type Brief } from "./brief";
import { adminChangeToken, bumpAdminOwnerRevision, bumpAdminPublicRevision, recordAdminToolChange } from "./adminRevision";

// RFC 6455 section 7.4.1: these codes describe a close but must never be sent in a close frame.
const UNSENDABLE_CLOSE_CODES = new Set([1005, 1006, 1015]);
const NORMAL_CLOSURE = 1000;
const POLICY_VIOLATION = 1008;

interface StreamAttachment {
  openedAt?: number;
  grantId?: string;
}

const streamAttachment = (socket: WebSocket): StreamAttachment => (socket.deserializeAttachment() as StreamAttachment | null) ?? {};
const openedAt = (socket: WebSocket): number => streamAttachment(socket).openedAt ?? 0;

// Tools served by the workspace object. Each runs in one transaction.

const ASYNC_TOOLS = new Set(["search_messages", "upload_file", "watch_inbox"]);

const TOOLS: Record<string, (scope: Scope, args: never, grantId: string) => unknown> = {
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
  watch_inbox: watchInbox,
  mark_read: markRead,
  get_notification_prefs: getNotificationPrefs,
  set_notification_prefs: setNotificationPrefs,
  search_messages: searchMessages,
  upload_file: uploadFile,
  moderate,
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
  sessionHash: string | null;
  processHash: string | null;
}

export interface WorkspaceIdentity {
  workspaceId: string;
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
  private workspaceDomain: string | undefined;

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

  // The domain is the workspace's Google hd claim from D1, never the caller's email domain, which can be a secondary domain.
  private async rememberWorkspace(identity: WorkspaceIdentity): Promise<string> {
    this.workspaceDomain ??= (await findWorkspaceDomain(this.env.DB, identity.workspaceId)).toLowerCase();
    this.sql.exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('workspace_id', ?)", identity.workspaceId);
    this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('domain', ?)", this.workspaceDomain);
    return this.workspaceDomain;
  }

  private scopeFor(agent: AgentRow, workspaceId: string, now: number): Scope {
    return { sql: this.sql, now, agent, workspaceId, env: this.env, indexJobs: [] };
  }

  async registerAgent(agent: NewAgent, identity: WorkspaceIdentity, grantId: string): Promise<RegisterOutcome> {
    const now = Date.now();
    const domain = await this.rememberWorkspace(identity);
    const handle = fullHandle(handleOwner(agent.ownerSub, agent.ownerEmail, domain), agent.agentName);
    return this.ctx.storage.transactionSync((): RegisterOutcome => {
      const existing = one<AgentRow>(this.sql, "SELECT * FROM agents WHERE handle = ?", handle);
      if (existing && existing.owner_sub !== agent.ownerSub) {
        return { status: "refused", error: `@${handle} belongs to another carbon unit; choose another name` };
      }
      const banned = banNotice({ sql: this.sql }, { ownerSub: agent.ownerSub, agentId: existing?.id });
      if (banned) return { status: "refused", error: banned };
      if (existing?.revoked_at) return { status: "refused", error: `@${handle} was revoked; choose another name` };
      if (!existing && !agent.id) return { status: "needs_record" };
      if (existing) {
        if (this.isHeldByAnotherSession(existing, agent, now)) return { status: "refused", error: nameInUseRefusal(handle, this.freeNameBeside(handle, agent.ownerSub, now)) };
        if (agent.description) run(this.sql, "UPDATE agents SET description = ? WHERE id = ?", agent.description, existing.id);
        this.claimForSession(existing, agent);
        run(this.sql, "UPDATE agents SET last_active_at = ? WHERE id = ?", now, existing.id);
      }
      if (!existing) {
        run(
          this.sql,
          `INSERT INTO agents (id, handle, name, description, owner_sub, owner_email, owner_name, created_at, last_active_at, session_hash, process_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          agent.id,
          handle,
          agent.agentName,
          agent.description ?? "",
          agent.ownerSub,
          agent.ownerEmail,
          agent.ownerName,
          now,
          now,
          agent.sessionHash,
          agent.processHash,
        );
      }
      run(this.sql, "UPDATE agents SET owner_email = ?, owner_name = ? WHERE owner_sub = ?", agent.ownerEmail, agent.ownerName, agent.ownerSub);
      const registered = one<AgentRow>(this.sql, "SELECT * FROM agents WHERE handle = ?", handle)!;
      if (!existing) joinDefaultChannels(this.scopeFor(registered, identity.workspaceId, now));
      this.audit(grantId, registered.id, "register_agent");
      bumpAdminPublicRevision(this.sql);
      return { status: "registered", handle, created: !existing, brief: buildBrief(this.scopeFor(registered, identity.workspaceId, now)) };
    });
  }

  private isHeldByAnotherSession(existing: AgentRow, agent: NewAgent, now: number): boolean {
    if (!agent.sessionHash || !existing.session_hash || existing.session_hash === agent.sessionHash) return false;
    if (agent.processHash && existing.process_hash === agent.processHash) return false;
    return now - existing.last_active_at < LIMITS.agentNameHoldMs || this.ctx.getWebSockets(existing.id).length > 0;
  }

  private freeNameBeside(heldHandle: string, ownerSub: string, now: number): string {
    return freeSessionName(this.sql, heldHandle, ownerSub, (candidate) => isNameHoldExpired(candidate, now) && this.ctx.getWebSockets(candidate.id).length === 0);
  }

  private claimForSession(existing: AgentRow, agent: NewAgent): void {
    if (agent.processHash) run(this.sql, "UPDATE agents SET process_hash = ? WHERE id = ?", agent.processHash, existing.id);
    if (!agent.sessionHash || existing.session_hash === agent.sessionHash) return;
    if (existing.session_hash) this.endAgentStreams(existing.id, "agent name taken over by another session");
    run(this.sql, "UPDATE agents SET session_hash = ? WHERE id = ?", agent.sessionHash, existing.id);
  }

  private finishModeration(outcome: ModerationOutcome): Record<string, unknown> {
    for (const agentId of outcome.endStreamsFor) this.endAgentStreams(agentId, "agent banned by a moderator");
    return outcome.output;
  }

  private endAgentStreams(agentId: string, reason: string): void {
    run(this.sql, "DELETE FROM stream_tickets WHERE agent_id = ?", agentId);
    for (const socket of this.ctx.getWebSockets(agentId)) socket.close(POLICY_VIOLATION, reason);
  }

  private resolveCaller(caller: ToolCaller, domain: string): AgentRow | string {
    const owner = handleOwner(caller.ownerSub, caller.ownerEmail, domain);
    const ref = caller.agent.trim().toLowerCase().replace(/^@/, "");
    const [refOwner, refName] = ref.includes("/") ? ref.split("/", 2) : [owner, ref];
    if (refOwner !== owner) return `@${ref} belongs to another carbon unit; you can act only as your own agents (@${owner}/…)`;
    const ownerBanned = banNotice({ sql: this.sql }, { ownerSub: caller.ownerSub });
    if (ownerBanned) return ownerBanned;
    const agent = one<AgentRow>(
      this.sql,
      "SELECT * FROM agents WHERE handle = ? AND owner_sub = ? AND revoked_at IS NULL",
      fullHandle(owner, refName),
      caller.ownerSub,
    );
    if (agent) return banNotice({ sql: this.sql }, { ownerSub: agent.owner_sub, agentId: agent.id }) ?? agent;
    const yours = all<{ name: string }>(this.sql, "SELECT name FROM agents WHERE owner_sub = ? AND revoked_at IS NULL ORDER BY last_active_at DESC", caller.ownerSub)
      .map((row) => row.name)
      .slice(0, 10);
    const notFound = `no agent named '${refName}' for ${caller.ownerEmail}`;
    if (!yours.length) return `${notFound}. Call register_agent with name '${refName}' to create it`;
    return `${notFound}; your agents: ${yours.join(", ")}. Call register_agent with one of those names to reclaim it, or with name '${refName}' to create it`;
  }

  async tool(name: string, caller: ToolCaller, args: Record<string, unknown>): Promise<ToolOutcome> {
    const handler = TOOLS[name];
    if (!handler) return { error: `unknown tool ${name}` };
    const domain = await this.rememberWorkspace(caller);
    const now = Date.now();
    const agent = this.resolveCaller(caller, domain);
    if (typeof agent === "string") return { error: agent };

    if (run(this.sql, "UPDATE agents SET last_active_at = ? WHERE id = ? AND last_active_at < ?", now, agent.id, now - 60_000)) {
      bumpAdminOwnerRevision(this.sql, caller.ownerSub);
    }
    if (caller.ownerName && caller.ownerName !== agent.owner_name) {
      run(this.sql, "UPDATE agents SET owner_name = ? WHERE owner_sub = ?", caller.ownerName, agent.owner_sub);
      agent.owner_name = caller.ownerName;
      bumpAdminPublicRevision(this.sql);
    }
    this.audit(caller.grantId, agent.id, name);
    const limited = this.takeTokens(name, agent.id, caller, now);
    if (limited) return { error: limited };
    const scope = this.scopeFor(agent, caller.workspaceId, now);
    if (name === "moderate") scope.moderatorSubs = new Set(await workspaceAdminSubs(this.env.DB, caller.workspaceId));
    const invoke = () => {
      const output = handler(scope, args as never, caller.grantId);
      if (!ASYNC_TOOLS.has(name)) recordAdminToolChange(this.sql, caller.ownerSub, name, output as Record<string, unknown>);
      return output;
    };
    try {
      const result = ASYNC_TOOLS.has(name) ? await invoke() : this.ctx.storage.transactionSync(invoke);
      const output = name === "moderate" ? this.finishModeration(result as ModerationOutcome) : result;
      await this.sendIndexJobs(caller.workspaceId, scope.indexJobs);
      if (name === "send_message") this.flushWatchers();
      return { output: output as Record<string, unknown> };
    } catch (error) {
      if (error instanceof ToolError) return { error: error.message };
      throw error;
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (!isWebSocketUpgrade(request)) return new Response("expected a WebSocket upgrade\n", { status: 426 });
    const ticket = streamTicketFrom(request);
    const workspaceId = STREAM_ROUTE.exec(new URL(request.url).pathname)?.[1];
    if (!ticket || !workspaceId) return unauthorizedStream();
    const ticketHash = await sha256Hex(ticket);
    const holder = this.streamTicketHolder(ticketHash);
    if (!holder) return unauthorizedStream();
    const grant = { grantId: holder.grant_id, ownerSub: holder.owner_sub, workspaceId };
    if (!(await isStreamGrantLive(this.env, grant, Date.now()))) return unauthorizedStream();
    if (!this.streamTicketHolder(ticketHash)) return unauthorizedStream();
    const agentId = holder.agent_id;
    this.closeOldestSocketsBeyondCap(agentId);
    const [client, server] = Object.values(new WebSocketPair());
    server.serializeAttachment({ openedAt: Date.now(), grantId: holder.grant_id } satisfies StreamAttachment);
    this.ctx.acceptWebSocket(server, [agentId]);
    this.flushPending(agentId);
    return new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": STREAM_PROTOCOL } });
  }

  webSocketMessage(): void {}

  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    socket.close(UNSENDABLE_CLOSE_CODES.has(code) ? NORMAL_CLOSURE : code, reason);
  }

  private closeOldestSocketsBeyondCap(agentId: string): void {
    const openSocketsOldestFirst = this.ctx
      .getWebSockets(agentId)
      .filter((socket) => socket.readyState === WebSocket.OPEN)
      .sort((first, second) => openedAt(first) - openedAt(second));
    const socketsToClose = openSocketsOldestFirst.length - (LIMITS.openStreamSocketsPerAgent - 1);
    for (const socket of openSocketsOldestFirst.slice(0, Math.max(socketsToClose, 0))) {
      socket.close(POLICY_VIOLATION, "too many open streams for this agent");
    }
  }

  private streamTicketHolder(ticketHash: string): { agent_id: string; grant_id: string; owner_sub: string } | undefined {
    return one<{ agent_id: string; grant_id: string; owner_sub: string }>(
      this.sql,
      `SELECT t.agent_id, t.grant_id, a.owner_sub FROM stream_tickets t JOIN agents a ON a.id = t.agent_id
       WHERE t.ticket_hash = ? AND t.expires_at > ? AND a.revoked_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM bans b WHERE (b.kind = 'agent' AND b.subject = a.id) OR (b.kind = 'owner' AND b.subject = a.owner_sub))
         AND (t.session_hash IS NULL OR t.session_hash IS a.session_hash)`,
      ticketHash,
      Date.now(),
    );
  }

  async revokeGrantStreams(grantId: string): Promise<void> {
    run(this.sql, "DELETE FROM stream_tickets WHERE grant_id = ?", grantId);
    const grantSockets = this.ctx.getWebSockets().filter((socket) => streamAttachment(socket).grantId === grantId);
    for (const socket of grantSockets) socket.close(POLICY_VIOLATION, "credential revoked");
  }

  private flushWatchers(): void {
    const watchedAgentIds = new Set(this.ctx.getWebSockets().flatMap((socket) => this.ctx.getTags(socket)));
    for (const agentId of watchedAgentIds) this.flushPending(agentId);
  }

  private flushPending(agentId: string): void {
    const openSockets = this.ctx.getWebSockets(agentId).filter((socket) => socket.readyState === WebSocket.OPEN);
    if (!openSockets.length) return;
    const pending = one<{ message_id: number; reason: string }>(
      this.sql,
      `SELECT message_id, reason ${VISIBLE_UNREAD_INBOX}
       AND message_id > (SELECT push_cursor FROM agents WHERE id = ?1)
       ORDER BY message_id LIMIT 1`,
      agentId,
    );
    if (!pending) return;
    const event = JSON.stringify(this.pushEvent(pending.message_id, pending.reason));
    for (const socket of openSockets) socket.send(event);
    run(
      this.sql,
      "UPDATE agents SET push_cursor = (SELECT max(message_id) FROM inbox WHERE agent_id = ?1) WHERE id = ?1",
      agentId,
    );
  }

  private pushEvent(messageId: number, reason: string) {
    const message = one<MessageRow>(this.sql, "SELECT * FROM messages WHERE id = ?", messageId)!;
    const conversation = one<ConversationRow>(this.sql, "SELECT * FROM conversations WHERE id = ?", message.conversation_id)!;
    const author = one<{ handle: string }>(this.sql, "SELECT handle FROM agents WHERE id = ?", message.author_id);
    return {
      reason,
      conversation: label(conversation),
      message: messageRef(conversation, message.seq),
      from: `@${author?.handle ?? "unknown"}`,
    };
  }

  async adminChangeToken(caller: AdminCaller): Promise<string> {
    return adminChangeToken(this.sql, caller.sub, Date.now());
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
    this.endAgentStreams(agent.id, "agent revoked");
    bumpAdminOwnerRevision(this.sql, ownerSub);
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
      readStateChanged: () => bumpAdminOwnerRevision(this.sql, caller.sub),
    };
  }

  private async sendIndexJobs(workspaceId: string, jobs: PendingIndexJob[]): Promise<void> {
    const messages = jobs.map(({ delaySeconds, ...job }) => ({ body: { ...job, ws: workspaceId } as IndexJob, delaySeconds }));
    for (const batch of queueBatches(messages)) {
      try {
        await this.env.INDEX_QUEUE.sendBatch(batch);
      } catch (error) {
        console.error(`${batch.length} index jobs not queued; lexical search still covers these messages`, error);
      }
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
      bumpAdminPublicRevision(this.sql);
    });
  }

  async indexDocuments(workspaceId: string, jobs: IndexJob[]): Promise<(IndexDocument | null)[]> {
    return jobs.map((job) => buildDocument(this.sql, workspaceId, job));
  }

  async conversationSlugs(conversationIds: number[]): Promise<Record<number, string>> {
    const rows = all<{ id: number; slug: string }>(
      this.sql,
      "SELECT id, slug FROM conversations WHERE id IN (SELECT value FROM json_each(?))",
      JSON.stringify(conversationIds),
    );
    return Object.fromEntries(rows.map((row) => [row.id, row.slug]));
  }

  async reindexBatch(afterMessageId: number, limit: number) {
    return reindexJobs(this.sql, afterMessageId, limit);
  }

  // Token buckets (BUILD.md, Starting limits). Returns an error with a retry time, or null.
  private takeTokens(tool: string, agentId: string, caller: ToolCaller, now: number): string | null {
    const limits = RATE_LIMITS[tool] ?? [];
    if (limits.length) pruneRateBuckets(this.sql, now);
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
