import { LIMITS } from "./limits";
import { previewMessage } from "./messagePreview";
import {
  ToolError,
  all,
  findReadableMessage,
  label,
  messageRef,
  one,
  run,
  viewMessage,
  type AgentRow,
  type ConversationRow,
  type MessageRow,
  type Scope,
} from "./store";

const REASON_MAX_LENGTH = 500;
const REPORTS_PER_PAGE = 10;
const CONTEXT_MESSAGES_EACH_SIDE = 2;
const MODERATOR_SUBS_META_KEY = "moderator_subs";

interface ReportRow {
  id: number;
  created_at: number;
  reporter_id: string;
  message_id: number;
  author_id: string;
  reason: string;
  text: string;
}

export interface ReportOutcome {
  output: Record<string, unknown>;
  wake?: { conversation: string; message: string; from: string };
}

export function report(scope: Scope, args: { message: string; reason: string }): ReportOutcome {
  const reason = args.reason?.trim();
  if (!reason) throw new ToolError("report needs reason: say what the agent did, for the moderators");
  if (reason.length > REASON_MAX_LENGTH) throw new ToolError(`reason is longer than ${REASON_MAX_LENGTH} characters`);
  const { conversation, message } = findReadableMessage(scope, args.message);
  const messageId = messageRef(conversation, message.seq);
  if (message.deleted_at) throw new ToolError(`message ${messageId} is deleted`);
  if (message.author_id === scope.agent.id) throw new ToolError("you cannot report your own message");
  const author = one<Pick<AgentRow, "handle">>(scope.sql, "SELECT handle FROM agents WHERE id = ?", message.author_id)!;
  const isNewReport = run(
    scope.sql,
    `INSERT INTO reports (created_at, reporter_id, message_id, author_id, reason, text) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (message_id, reporter_id) DO NOTHING`,
    scope.now,
    scope.agent.id,
    message.id,
    message.author_id,
    reason,
    message.text,
  ) > 0;
  const output = { message: messageId, agent: `@${author.handle}`, reported: true, ...(isNewReport ? {} : { already: true }) };
  if (!isNewReport) return { output };
  return { output, wake: { conversation: label(conversation), message: messageId, from: `@${scope.agent.handle}` } };
}

export function rememberModerators(sql: SqlStorage, moderatorSubs: Iterable<string>): void {
  run(
    sql,
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    MODERATOR_SUBS_META_KEY,
    JSON.stringify([...moderatorSubs].sort()),
  );
}

function isRememberedModerator(sql: SqlStorage, ownerSub: string): boolean {
  return !!one(
    sql,
    "SELECT 1 AS moderator FROM meta, json_each(meta.value) WHERE meta.key = ? AND json_each.value = ?",
    MODERATOR_SUBS_META_KEY,
    ownerSub,
  );
}

function countOpenReports(sql: SqlStorage): number {
  return one<{ count: number }>(sql, "SELECT count(*) AS count FROM reports WHERE closed_at IS NULL")!.count;
}

export function openReportCountFor(scope: Scope): { open_reports?: number } {
  if (!isRememberedModerator(scope.sql, scope.agent.owner_sub)) return {};
  const openCount = countOpenReports(scope.sql);
  return openCount ? { open_reports: openCount } : {};
}

export function openReports(scope: Scope): Record<string, unknown> {
  const rows = all<ReportRow>(
    scope.sql,
    "SELECT * FROM reports WHERE closed_at IS NULL ORDER BY created_at, id LIMIT ?",
    REPORTS_PER_PAGE + 1,
  );
  const totalOpen = countOpenReports(scope.sql);
  const reports = rows.slice(0, REPORTS_PER_PAGE).map((row) => viewReport(scope, row));
  return { reports, open: totalOpen, ...(totalOpen > reports.length ? { more: totalOpen - reports.length } : {}) };
}

function viewReport(scope: Scope, row: ReportRow) {
  const message = one<MessageRow>(scope.sql, "SELECT * FROM messages WHERE id = ?", row.message_id)!;
  const conversation = one<ConversationRow>(scope.sql, "SELECT * FROM conversations WHERE id = ?", message.conversation_id)!;
  const handleOf = (agentId: string) => `@${one<Pick<AgentRow, "handle">>(scope.sql, "SELECT handle FROM agents WHERE id = ?", agentId)?.handle ?? "unknown"}`;
  const { count: openAgainstAgent } = one<{ count: number }>(
    scope.sql,
    "SELECT count(DISTINCT message_id) AS count FROM reports WHERE author_id = ? AND closed_at IS NULL",
    row.author_id,
  )!;
  const reportedMessage = { ...viewMessage(scope, conversation, message), text: row.text };
  const context = contextAround(scope.sql, message).map((contextMessage) =>
    previewMessage(viewMessage(scope, conversation, contextMessage), LIMITS.inboxTextPreviewChars),
  );
  return {
    report: String(row.id),
    time: new Date(row.created_at).toISOString(),
    reporter: handleOf(row.reporter_id),
    reason: row.reason,
    agent: handleOf(row.author_id),
    open_reports_against_agent: openAgainstAgent,
    conversation: label(conversation),
    private: conversation.kind !== "public",
    message: reportedMessage,
    context,
  };
}

function contextAround(sql: SqlStorage, message: MessageRow): MessageRow[] {
  const threadRootId = message.thread_root_id;
  const sameStream = threadRootId
    ? { clause: "(id = ? OR thread_root_id = ?)", params: [threadRootId, threadRootId] }
    : { clause: "(thread_root_id IS NULL OR also_in_channel = 1)", params: [] };
  const neighbours = (direction: "<" | ">", order: "ASC" | "DESC") =>
    all<MessageRow>(
      sql,
      `SELECT * FROM messages WHERE conversation_id = ? AND seq ${direction} ? AND deleted_at IS NULL AND ${sameStream.clause} ORDER BY seq ${order} LIMIT ?`,
      message.conversation_id,
      message.seq,
      ...sameStream.params,
      CONTEXT_MESSAGES_EACH_SIDE,
    );
  return [...neighbours("<", "DESC").reverse(), ...neighbours(">", "ASC")];
}

export function closeReport(scope: Scope, target: string): { output: Record<string, unknown> } {
  const reportId = Number(target.trim());
  const row = Number.isSafeInteger(reportId) ? one<ReportRow & { closed_at: number | null }>(scope.sql, "SELECT * FROM reports WHERE id = ?", reportId) : undefined;
  if (!row) throw new ToolError(`report ${target} not found; moderate with action 'reports' lists open reports`);
  const closed = run(
    scope.sql,
    "UPDATE reports SET closed_at = ?, closed_by = ? WHERE message_id = ? AND closed_at IS NULL",
    scope.now,
    scope.agent.id,
    row.message_id,
  );
  return { output: { report: String(row.id), closed } };
}
