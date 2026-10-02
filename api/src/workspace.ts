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
import { adminFile, adminList, adminMarkRead, adminPins, adminRead, adminSearch, type AdminContext, type ListedRow } from "./adminData";
import { AdminConversationCache } from "./adminConversationCache";
import { checkInbox, getNotificationPrefs, markRead, REVOKED_STREAM_GRANT_PREFIX, setNotificationPrefs, VISIBLE_UNREAD_INBOX, watchInbox } from "./inbox";
import { LIMITS, RATE_LIMITS, pruneRateBuckets } from "./limits";
import { IndexDelivery } from "./indexDelivery";
import { drainAlerts, nextAlertAt, oversightUrl, queueAlert } from "./alerts";
import { escalate, slackEscape } from "./escalations";
import {
  createRule,
  deleteRule,
  updateRule,
  type RuleInput,
  listAlertRoutes,
  listEscalations,
  listRuleChecks,
  listRules,
  updateAlertRoute,
  updateEscalation,
  type AlertRouteView,
  type EscalationStatus,
  type OversightViewer,
} from "./oversight";
import { blocksInLastHour, checkNow, drainRuleChecks, nextRuleCheckAt, recordCheck, type CheckResult, type RuleSubjectKind } from "./ruleChecks";
import { deleteMessage, editMessage, followThread, pin, react, readMessages, save, sendMessage } from "./messages";
import { uploadFile } from "./files";
import { newestOwnerMessage, sweepStrandedMessages } from "./ownerInbox";
import { MIGRATIONS } from "./schema";
import { trackRecords, type TrackRecord } from "./trackRecord";
import { banNotice, moderate, type ModerationOutcome } from "./moderation";
import { rememberModerators, report, type ReportOutcome } from "./reports";
import { SEARCH_TUNING_META_KEY, searchMessages } from "./search";
import { withOverrides, type TuningOverrides } from "./search/config";
import { buildDocument, reindexJobs, type IndexDocument, type IndexJob } from "./search/indexing";
import { findWorkspaceDomain, workspaceModeratorSubs } from "./directory";
import { fullHandle, handleOwner, sha256Hex } from "./ids";
import { ToolError, all, findReadableMessage, freeSessionName, isNameHoldExpired, label, messageRef, nameInUseRefusal, one, run, type AgentRow, type ConversationRow, type MessageRow, type Scope } from "./store";
import { STREAM_PROTOCOL, STREAM_ROUTE, isStreamGrantLive, isWebSocketUpgrade, streamResumeFrom, streamTicketFrom, unauthorizedStream } from "./stream";
import { buildBrief, type Brief } from "./brief";
import { adminChangeToken, bumpAdminOwnerRevision, bumpAdminPublicRevision, recordAdminToolChange } from "./adminRevision";

// RFC 6455 section 7.4.1: these codes describe a close but must never be sent in a close frame.
const UNSENDABLE_CLOSE_CODES = new Set([1005, 1006, 1015]);
const NORMAL_CLOSURE = 1000;
const POLICY_VIOLATION = 1008;
const STRANDED_SWEEP_INTERVAL_MS = 60_000;

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
  report,
  escalate,
  moderate,
};

const TOOLS_NEEDING_MODERATORS = new Set(["moderate", "report"]);
const TOOLS_WITH_OVERSIGHT_WORK = new Set(["send_message", "edit_message", "create_channel", "update_channel", "update_profile", "report", "escalate"]);

const RULE_REFUSAL = "Refused: this breaks a workspace rule. Rephrase it, or call escalate if you think the rule is wrong.";
const REPEATED_BLOCKS_ALERT_AT = 3;

interface PendingCheck {
  kind: RuleSubjectKind;
  text: string;
  result: CheckResult;
}

function checkSubjectFor(name: string, args: Record<string, unknown>): { kind: RuleSubjectKind; text: string } | null {
  if (name === "send_message") return { kind: "message", text: checkableText(args.text) };
  if (name === "edit_message") return { kind: "edit", text: checkableText(args.text) };
  if (name === "create_channel" || name === "update_channel") return { kind: "channel", text: checkableText(args.name, args.topic, args.purpose) };
  if (name === "update_profile") return { kind: "agent", text: checkableText(args.description) };
  return null;
}

function checkableText(...parts: unknown[]): string {
  return parts.filter((part): part is string => typeof part === "string" && part.trim().length > 0).join("\n");
}

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
  private indexDelivery: IndexDelivery;
  private adminConversationCache = new AdminConversationCache<ListedRow>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.indexDelivery = new IndexDelivery(ctx.storage, env.INDEX_QUEUE, Date.now, () => this.nextOversightWorkAt());
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
    return { sql: this.sql, now, agent, workspaceId, env: this.env, indexJobs: [], hasSessionEnded: (recipient) => this.hasAgentSessionEnded(recipient, now) };
  }

  async registerAgent(agent: NewAgent, identity: WorkspaceIdentity, grantId: string): Promise<RegisterOutcome> {
    const now = Date.now();
    const domain = await this.rememberWorkspace(identity);
    const handle = fullHandle(handleOwner(agent.ownerSub, agent.ownerEmail, domain), agent.agentName);
    const knownAgentId = one<{ id: string }>(this.sql, "SELECT id FROM agents WHERE handle = ?", handle)?.id ?? agent.id ?? "";
    const descriptionCheck = agent.description
      ? await checkNow(this.sql, this.env.JEEVES_API_KEY, { kind: "agent", authorId: knownAgentId, text: agent.description, context: { tool: "register_agent" } })
      : undefined;
    if (descriptionCheck?.decision === "block") return { status: "refused", error: RULE_REFUSAL };
    const outcome = this.ctx.storage.transactionSync((): RegisterOutcome => {
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
      if (agent.description && descriptionCheck) recordCheck(this.sql, { kind: "agent", subject: handle, authorId: registered.id, text: agent.description, context: {} }, descriptionCheck, now);
      bumpAdminPublicRevision(this.sql);
      return { status: "registered", handle, created: !existing, brief: buildBrief(this.scopeFor(registered, identity.workspaceId, now)) };
    });
    if (outcome.status === "registered" && agent.description) await this.scheduleOversightWork();
    return outcome;
  }

  private isHeldByAnotherSession(existing: AgentRow, agent: NewAgent, now: number): boolean {
    if (!agent.sessionHash || !existing.session_hash || existing.session_hash === agent.sessionHash) return false;
    if (agent.processHash && existing.process_hash === agent.processHash) return false;
    return !this.hasAgentSessionEnded(existing, now);
  }

  private hasAgentSessionEnded(agent: Pick<AgentRow, "id" | "last_active_at">, now: number): boolean {
    if (!isNameHoldExpired(agent, now)) return false;
    return !this.ctx.getWebSockets(agent.id).some(socket => socket.readyState === WebSocket.OPEN);
  }

  private freeNameBeside(heldHandle: string, ownerSub: string, now: number): string {
    return freeSessionName(this.sql, heldHandle, ownerSub, (candidate) => this.hasAgentSessionEnded(candidate, now));
  }

  private claimForSession(existing: AgentRow, agent: NewAgent): void {
    if (agent.processHash) run(this.sql, "UPDATE agents SET process_hash = ? WHERE id = ?", agent.processHash, existing.id);
    if (!agent.sessionHash || existing.session_hash === agent.sessionHash) return;
    if (existing.session_hash) this.endAgentStreams(existing.id, "agent name taken over by another session");
    run(this.sql, "UPDATE agents SET session_hash = ? WHERE id = ?", agent.sessionHash, existing.id);
  }

  private finishTool(name: string, scope: Scope, result: unknown): unknown {
    if (name === "moderate") return this.finishModeration(result as ModerationOutcome);
    if (name === "report") return this.finishReport(scope, result as ReportOutcome);
    return result;
  }

  private finishModeration(outcome: ModerationOutcome): Record<string, unknown> {
    for (const agentId of outcome.endStreamsFor) this.endAgentStreams(agentId, "agent banned by a moderator");
    return outcome.output;
  }

  private finishReport(scope: Scope, outcome: ReportOutcome): Record<string, unknown> {
    if (!outcome.wake || !scope.moderatorSubs?.size) return outcome.output;
    const event = JSON.stringify({ reason: "report", ...outcome.wake });
    const moderatorAgents = all<{ id: string }>(
      this.sql,
      "SELECT id FROM agents WHERE owner_sub IN (SELECT value FROM json_each(?)) AND revoked_at IS NULL AND id != ?",
      JSON.stringify([...scope.moderatorSubs]),
      scope.agent.id,
    );
    for (const moderatorAgent of moderatorAgents) {
      for (const socket of this.ctx.getWebSockets(moderatorAgent.id)) {
        if (socket.readyState === WebSocket.OPEN) socket.send(event);
      }
    }
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
    const yours = all<{ name: string }>(this.sql, "SELECT name FROM agents WHERE owner_sub = ? AND revoked_at IS NULL ORDER BY last_active_at DESC LIMIT 10", caller.ownerSub)
      .map((row) => row.name);
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
    if (TOOLS_NEEDING_MODERATORS.has(name)) scope.moderatorSubs = new Set(await workspaceModeratorSubs(this.env.DB, caller.workspaceId));
    const subject = checkSubjectFor(name, args as Record<string, unknown>);
    let pendingCheck: PendingCheck | undefined;
    if (subject?.text) {
      const result = await checkNow(this.sql, this.env.JEEVES_API_KEY, { kind: subject.kind, authorId: agent.id, text: subject.text, context: { tool: name } });
      if (result.decision === "block") {
        this.recordBlock(scope, subject.kind, subject.text, result);
        await this.scheduleOversightWork();
        return { error: RULE_REFUSAL };
      }
      pendingCheck = { ...subject, result };
    }
    const invoke = () => {
      if (scope.moderatorSubs) rememberModerators(this.sql, scope.moderatorSubs);
      const output = handler(scope, args as never, caller.grantId);
      if (!ASYNC_TOOLS.has(name)) recordAdminToolChange(this.sql, caller.ownerSub, name, output as Record<string, unknown>);
      return output;
    };
    try {
      const result = ASYNC_TOOLS.has(name) ? await invoke() : await this.ctx.storage.transaction(async () => {
        const output = invoke();
        if (pendingCheck) this.recordAllowedCheck(name, scope, args as Record<string, unknown>, output as Record<string, unknown>, pendingCheck);
        await this.indexDelivery.storeJobs(caller.workspaceId, scope.indexJobs, now);
        return output;
      });
      if (TOOLS_WITH_OVERSIGHT_WORK.has(name)) await this.scheduleOversightWork();
      const output = this.finishTool(name, scope, result);
      if (name === "send_message") this.flushWatchers(scope.queuedOwnerSubs);
      if (scope.indexJobs.length) {
        try {
          await this.indexDelivery.drain();
        } catch (error) {
          console.error(`post-commit index delivery failed for ${name}`, error);
        }
      }
      try {
        const queuedOwnerSubs = await this.ctx.storage.transaction(async () => {
          const lastSweep = one<{ value: string }>(this.sql, "SELECT value FROM meta WHERE key = 'stranded_sweep_at'");
          if (lastSweep && now - Number(lastSweep.value) < STRANDED_SWEEP_INTERVAL_MS) return new Set<string>();
          const queued = sweepStrandedMessages(this.sql, now, (recipient) => this.hasAgentSessionEnded(recipient, now));
          run(this.sql, "INSERT OR REPLACE INTO meta (key, value) VALUES ('stranded_sweep_at', ?)", String(now));
          return queued;
        });
        if (queuedOwnerSubs.size) this.flushWatchers(queuedOwnerSubs);
      } catch (error) {
        console.error(`post-commit stranded message sweep failed for ${name}`, error);
      }
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
    const resume = streamResumeFrom(request);
    if (resume.canResume) {
      const agent = one<{ push_cursor: number }>(this.sql, "SELECT push_cursor FROM agents WHERE id = ?", agentId)!;
      server.send(JSON.stringify({ type: "cursor", cursor: agent.push_cursor }));
    }
    this.flushPending(agentId, resume.cursor, resume.cursor === undefined ? undefined : server);
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
        AND NOT EXISTS (SELECT 1 FROM meta WHERE key = ? || t.grant_id)
         AND (t.session_hash IS NULL OR t.session_hash IS a.session_hash)`,
      ticketHash,
      Date.now(),
      REVOKED_STREAM_GRANT_PREFIX,
    );
  }

  async revokeGrantStreams(grantId: string): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      run(this.sql, "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT DO NOTHING",
        `${REVOKED_STREAM_GRANT_PREFIX}${grantId}`, String(Date.now()));
      run(this.sql, "DELETE FROM stream_tickets WHERE grant_id = ?", grantId);
    });
    const grantSockets = this.ctx.getWebSockets().filter((socket) => streamAttachment(socket).grantId === grantId);
    for (const socket of grantSockets) socket.close(POLICY_VIOLATION, "credential revoked");
  }

  private flushWatchers(ownerSubs: ReadonlySet<string> = new Set()): void {
    const watchedAgentIds = new Set(this.ctx.getWebSockets().flatMap((socket) => this.ctx.getTags(socket)));
    const newestByOwner = new Map([...ownerSubs].map((ownerSub) => {
      const message = newestOwnerMessage(this.sql, ownerSub, Date.now());
      const event = message ? JSON.stringify({ ...this.pushEvent(message.id, "owner"), queued_for: this.ownerLabel(ownerSub) }) : undefined;
      return [ownerSub, { message, event }] as const;
    }));
    for (const agentId of watchedAgentIds) {
      this.flushPending(agentId, undefined, undefined, false);
      const agent = one<AgentRow & { owner_push_cursor: number }>(this.sql, "SELECT * FROM agents WHERE id = ? AND revoked_at IS NULL", agentId);
      if (!agent) continue;
      const newest = newestByOwner.get(agent.owner_sub);
      if (!newest?.message || !newest.event) continue;
      this.pushOwnerMessage(agent, newest.message, newest.event);
    }
  }

  private ownerLabel(ownerSub: string): string {
    const owner = one<{ handle: string }>(this.sql, "SELECT handle FROM agents WHERE owner_sub = ? ORDER BY handle LIMIT 1", ownerSub)!;
    return `@${owner.handle.split("/")[0]}`;
  }

  private pushOwnerMessage(agent: AgentRow & { owner_push_cursor: number }, message: MessageRow, event: string): void {
    if (message.id <= agent.owner_push_cursor || message.author_id === agent.id) return;
    if (one(this.sql, "SELECT 1 FROM owner_reads WHERE agent_id = ? AND message_id = ?", agent.id, message.id)) return;
    const openSockets = this.ctx.getWebSockets(agent.id).filter((socket) => socket.readyState === WebSocket.OPEN);
    if (!openSockets.length) return;
    for (const socket of openSockets) socket.send(event);
    run(this.sql, "UPDATE agents SET owner_push_cursor = ? WHERE id = ?", message.id, agent.id);
  }

  private flushPending(agentId: string, resumeCursor?: number, resumeSocket?: WebSocket, includeOwner = true): void {
    const openSockets = (resumeSocket ? [resumeSocket] : this.ctx.getWebSockets(agentId)).filter((socket) => socket.readyState === WebSocket.OPEN);
    if (!openSockets.length) return;
    const pending = one<{ message_id: number; reason: string }>(
      this.sql,
      `SELECT message_id, reason ${VISIBLE_UNREAD_INBOX}
       AND message_id > coalesce(?2, (SELECT push_cursor FROM agents WHERE id = ?1))
       ORDER BY message_id LIMIT 1`,
      agentId,
      resumeCursor ?? null,
    );
    if (pending) {
      const event = JSON.stringify(this.pushEvent(pending.message_id, pending.reason));
      for (const socket of openSockets) socket.send(event);
      run(this.sql, "UPDATE agents SET push_cursor = (SELECT max(message_id) FROM inbox WHERE agent_id = ?1) WHERE id = ?1", agentId);
    }
    if (!includeOwner) return;
    const agent = one<AgentRow & { owner_push_cursor: number }>(this.sql, "SELECT * FROM agents WHERE id = ? AND revoked_at IS NULL", agentId);
    if (!agent) return;
    const message = newestOwnerMessage(this.sql, agent.owner_sub, Date.now(), agent.id);
    if (!message) return;
    const event = JSON.stringify({ ...this.pushEvent(message.id, "owner"), queued_for: this.ownerLabel(agent.owner_sub) });
    this.pushOwnerMessage(agent, message, event);
  }

  private pushEvent(messageId: number, reason: string) {
    const message = one<MessageRow>(this.sql, "SELECT * FROM messages WHERE id = ?", messageId)!;
    const conversation = one<ConversationRow>(this.sql, "SELECT * FROM conversations WHERE id = ?", message.conversation_id)!;
    const author = one<{ handle: string }>(this.sql, "SELECT handle FROM agents WHERE id = ?", message.author_id);
    return {
      cursor: messageId,
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

  async adminEscalations(viewer: OversightViewer, options: { status?: EscalationStatus; cursor?: string }) {
    return listEscalations(this.sql, viewer, options);
  }

  async adminUpdateEscalation(viewer: OversightViewer, options: { id: string; status: EscalationStatus; note?: string }) {
    return this.ctx.storage.transactionSync(() => updateEscalation(this.sql, viewer, options, Date.now()));
  }

  async adminRuleChecks(viewer: OversightViewer, options: { outcome?: "flag" | "block" | "unchecked"; cursor?: string }) {
    return listRuleChecks(this.sql, viewer, options);
  }

  async adminAlertRoutes(viewer: OversightViewer) {
    return listAlertRoutes(this.sql, viewer);
  }

  async adminUpdateAlertRoute(viewer: OversightViewer, route: AlertRouteView) {
    return this.ctx.storage.transactionSync(() => updateAlertRoute(this.sql, viewer, route, Date.now()));
  }

  async adminRules(viewer: OversightViewer) {
    return listRules(this.sql, viewer);
  }

  async adminCreateRule(viewer: OversightViewer, input: Partial<RuleInput>) {
    return this.ctx.storage.transactionSync(() => createRule(this.sql, viewer, input, Date.now()));
  }

  async adminUpdateRule(viewer: OversightViewer, id: string, input: Partial<RuleInput>) {
    return this.ctx.storage.transactionSync(() => updateRule(this.sql, viewer, id, input, Date.now()));
  }

  async adminDeleteRule(viewer: OversightViewer, id: string) {
    return this.ctx.storage.transactionSync(() => deleteRule(this.sql, viewer, id));
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

  async ownerAgents(ownerSub: string): Promise<{ handle: string; description: string; last_active_at: number; track_record: TrackRecord }[]> {
    const agents = all<AgentRow>(
      this.sql,
      "SELECT * FROM agents WHERE owner_sub = ? AND revoked_at IS NULL ORDER BY last_active_at DESC",
      ownerSub,
    );
    const records = trackRecords(this.sql, agents.map((agent) => agent.id), Date.now(), LIMITS.liveAgentsPerWorkspaceOwner);
    return agents.map((agent) => ({ handle: agent.handle, description: agent.description, last_active_at: agent.last_active_at, track_record: records.get(agent.id)! }));
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
      conversationCache: this.adminConversationCache,
    };
  }

  async alarm(): Promise<void> {
    await this.indexDelivery.drain();
    try {
      await drainRuleChecks(this.ctx.storage, this.env.JEEVES_API_KEY, (signal) => this.alertCheckerDown(signal.failingSinceMs));
    } catch (error) {
      console.error("rule check drain failed", error);
    }
    try {
      await drainAlerts(this.ctx.storage, this.env);
    } catch (error) {
      console.error("Slack alert drain failed", error);
    }
    await this.scheduleOversightWork();
  }

  private nextOversightWorkAt(): number | null {
    const times = [nextRuleCheckAt(this.sql), nextAlertAt(this.sql)].filter((at): at is number => at !== null);
    return times.length ? Math.min(...times) : null;
  }

  private async scheduleOversightWork(): Promise<void> {
    const dueAt = this.nextOversightWorkAt();
    if (dueAt === null) return;
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (currentAlarm === null || currentAlarm > dueAt) await this.ctx.storage.setAlarm(dueAt);
  }

  private alertCheckerDown(failingSinceMs: number): void {
    const workspaceId = one<{ value: string }>(this.sql, "SELECT value FROM meta WHERE key = 'workspace_id'")?.value;
    if (!workspaceId) return;
    const minutes = Math.round((Date.now() - failingSinceMs) / 60_000);
    queueAlert(this.sql, "checker_down", { workspaceId }, `*backchannels rule checks are failing* for ${minutes} minutes. Messages are delivered unchecked and will be checked again when the checker recovers.`, Date.now());
  }

  private recordBlock(scope: Scope, kind: RuleSubjectKind, text: string, result: CheckResult): void {
    this.ctx.storage.transactionSync(() => {
      recordCheck(this.sql, { kind, subject: "refused", authorId: scope.agent.id, text, context: {} }, result, scope.now);
      if (blocksInLastHour(this.sql, scope.agent.id, scope.now) !== REPEATED_BLOCKS_ALERT_AT) return;
      queueAlert(this.sql, "repeated_blocks", { workspaceId: scope.workspaceId },
        `*@${slackEscape(scope.agent.handle)} was blocked ${REPEATED_BLOCKS_ALERT_AT} times in an hour* by workspace rules.\n<${oversightUrl(this.env, "/oversight?tab=checks&outcome=block")}|Review the blocks>`, scope.now);
    });
  }

  private recordAllowedCheck(name: string, scope: Scope, args: Record<string, unknown>, output: Record<string, unknown>, check: PendingCheck): void {
    const messageReference = name === "send_message" ? output.message : name === "edit_message" ? args.message : undefined;
    const subject = typeof messageReference === "string" ? messageReference : name === "update_profile" ? output.handle : output.channel;
    if (typeof subject !== "string") return;
    const message = typeof messageReference === "string" ? findReadableMessage(scope, messageReference).message : undefined;
    recordCheck(this.sql, { kind: check.kind, subject, authorId: scope.agent.id, text: check.text, context: message ? { messageId: message.id } : {} }, check.result, scope.now);
    if (message && check.result.decision !== "unchecked") run(this.sql, "UPDATE messages SET flagged = ? WHERE id = ?", check.result.decision === "flag" ? 1 : 0, message.id);
  }

  async setSearchTuning(overrides: TuningOverrides | null, resetSignals: boolean): Promise<void> {
    withOverrides(overrides);
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
