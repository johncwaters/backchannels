import { lastAlertFailures, type AlertEvent, type AlertFailure } from "./alerts";
import type { Role } from "./directory";
import type { RuleVerdict } from "./ruleChecks";
import { all, one, run } from "./store";

export type OversightResult<T> = { ok: true; value: T } | { ok: false; error: "unauthorized" | "invalid" | "not_found" };

export interface OversightViewer {
  sub: string;
  role: Role;
}

export type EscalationStatus = "open" | "acknowledged" | "resolved";

export interface EscalationView {
  id: string;
  time: string;
  agent: string;
  owner: string;
  category: string;
  summary: string;
  messages: string[];
  actionTaken: string;
  status: EscalationStatus;
  statusBy: string | null;
  statusAt: string | null;
  note: string | null;
}

export interface RuleCheckView {
  id: string;
  time: string;
  kind: string;
  subject: string;
  author: string;
  text: string;
  outcome: "flag" | "block" | "unchecked";
  verdicts: RuleVerdict[];
  latencyMs: number | null;
}

export interface AlertRouteView {
  event: AlertEvent;
  destination: "owner" | "admins" | "channel";
  channel: string | null;
  enabled: boolean;
  lastFailure?: AlertFailure;
}

export interface RuleView {
  id: string;
  scope: "workspace" | "user";
  name: string;
  question: string;
  action: "block" | "flag";
  threshold: number;
  mode: "shadow" | "enforce";
  enabled: boolean;
  version: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

const PAGE_SIZE = 25;
const NOTE_MAX_LENGTH = 1_000;
const SLACK_CHANNEL = /^#[a-z0-9][a-z0-9_-]{0,79}$/;
const ESCALATION_STATUSES = new Set<EscalationStatus>(["open", "acknowledged", "resolved"]);
const ALERT_EVENTS = new Set<AlertEvent>(["escalation", "escalation_for_moderators", "report", "repeated_blocks", "checker_down"]);

const isModerator = (viewer: OversightViewer) => viewer.role === "admin" || viewer.role === "moderator";
const unauthorized = { ok: false, error: "unauthorized" } as const;
const invalid = { ok: false, error: "invalid" } as const;
const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString());

function cursorId(cursor: string | undefined): number | null | undefined {
  if (cursor === undefined) return null;
  const id = Number(cursor);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function page<T extends { id: string }>(rows: T[]): Page<T> {
  const items = rows.slice(0, PAGE_SIZE);
  return { items, nextCursor: rows.length > PAGE_SIZE ? items[items.length - 1].id : null };
}

interface EscalationRow {
  id: number;
  created_at: number;
  handle: string;
  owner_sub: string;
  owner_email: string;
  category: string;
  summary: string;
  message_ids: string;
  action_taken: string;
  status: EscalationStatus;
  status_by: string | null;
  status_at: number | null;
  note: string | null;
}

function viewEscalation(row: EscalationRow): EscalationView {
  return {
    id: String(row.id),
    time: new Date(row.created_at).toISOString(),
    agent: `@${row.handle}`,
    owner: row.owner_email,
    category: row.category,
    summary: row.summary,
    messages: JSON.parse(row.message_ids),
    actionTaken: row.action_taken,
    status: row.status,
    statusBy: row.status_by,
    statusAt: iso(row.status_at),
    note: row.note,
  };
}

const ESCALATION_SELECT = `SELECT e.*, a.handle, a.owner_sub, a.owner_email FROM escalations e JOIN agents a ON a.id = e.agent_id`;

export function listEscalations(sql: SqlStorage, viewer: OversightViewer, options: { status?: EscalationStatus; cursor?: string }): OversightResult<Page<EscalationView>> {
  const before = cursorId(options.cursor);
  if (before === undefined || (options.status && !ESCALATION_STATUSES.has(options.status))) return invalid;
  const rows = all<EscalationRow>(sql,
    `${ESCALATION_SELECT}
     WHERE (?1 IS NULL OR e.status = ?1) AND (?2 IS NULL OR e.id < ?2) AND (?3 = 1 OR a.owner_sub = ?4)
     ORDER BY e.id DESC LIMIT ?5`,
    options.status ?? null, before, isModerator(viewer) ? 1 : 0, viewer.sub, PAGE_SIZE + 1);
  return { ok: true, value: page(rows.map(viewEscalation)) };
}

export function updateEscalation(
  sql: SqlStorage,
  viewer: OversightViewer,
  options: { id: string; status: EscalationStatus; note?: string },
  now: number,
): OversightResult<EscalationView> {
  const id = cursorId(options.id);
  if (!id || !ESCALATION_STATUSES.has(options.status) || (options.note?.length ?? 0) > NOTE_MAX_LENGTH) return invalid;
  const row = one<EscalationRow>(sql, `${ESCALATION_SELECT} WHERE e.id = ?`, id);
  if (!row) return { ok: false, error: "not_found" };
  if (!isModerator(viewer) && row.owner_sub !== viewer.sub) return unauthorized;
  run(sql, "UPDATE escalations SET status = ?, status_by = ?, status_at = ?, note = coalesce(?, note) WHERE id = ?",
    options.status, viewer.sub, now, options.note?.trim() || null, id);
  return { ok: true, value: viewEscalation(one<EscalationRow>(sql, `${ESCALATION_SELECT} WHERE e.id = ?`, id)!) };
}

interface RuleCheckRow {
  id: number;
  created_at: number;
  subject_kind: string;
  subject_id: string;
  handle: string;
  text: string;
  outcome: "flag" | "block" | "unchecked";
  verdicts: string | null;
  latency_ms: number | null;
}

export function listRuleChecks(sql: SqlStorage, viewer: OversightViewer, options: { outcome?: "flag" | "block" | "unchecked"; cursor?: string }): OversightResult<Page<RuleCheckView>> {
  if (!isModerator(viewer)) return unauthorized;
  const before = cursorId(options.cursor);
  if (before === undefined || (options.outcome && !["flag", "block", "unchecked"].includes(options.outcome))) return invalid;
  const rows = all<RuleCheckRow>(sql,
    `SELECT c.id, c.created_at, c.subject_kind, c.subject_id, a.handle, c.text, c.outcome, c.verdicts, c.latency_ms
     FROM rule_checks c JOIN agents a ON a.id = c.author_id
     WHERE c.checked_at IS NOT NULL AND c.outcome != 'pass' AND (?1 IS NULL OR c.outcome = ?1) AND (?2 IS NULL OR c.id < ?2)
     ORDER BY c.id DESC LIMIT ?3`,
    options.outcome ?? null, before, PAGE_SIZE + 1);
  return {
    ok: true,
    value: page(rows.map((row) => ({
      id: String(row.id),
      time: new Date(row.created_at).toISOString(),
      kind: row.subject_kind,
      subject: row.subject_id,
      author: `@${row.handle}`,
      text: row.text,
      outcome: row.outcome,
      verdicts: row.verdicts ? JSON.parse(row.verdicts) : [],
      latencyMs: row.latency_ms,
    }))),
  };
}

export function listAlertRoutes(sql: SqlStorage, viewer: OversightViewer): OversightResult<AlertRouteView[]> {
  if (!isModerator(viewer)) return unauthorized;
  const rows = all<{ event: AlertEvent; destination: AlertRouteView["destination"]; channel: string | null; enabled: number }>(sql,
    "SELECT event, destination, channel, enabled FROM alert_routes ORDER BY event");
  const failures = lastAlertFailures(sql);
  return { ok: true, value: rows.map((row) => ({ ...row, enabled: row.enabled === 1, ...(failures.has(row.event) ? { lastFailure: failures.get(row.event)! } : {}) })) };
}

export function updateAlertRoute(sql: SqlStorage, viewer: OversightViewer, route: AlertRouteView, now: number): OversightResult<AlertRouteView[]> {
  if (viewer.role !== "admin") return unauthorized;
  if (!ALERT_EVENTS.has(route.event) || !["owner", "admins", "channel"].includes(route.destination)) return invalid;
  if (route.destination === "owner" && !route.event.startsWith("escalation")) return invalid;
  const channel = route.destination === "channel" ? route.channel?.trim().toLowerCase() ?? "" : null;
  if (channel !== null && !SLACK_CHANNEL.test(channel)) return invalid;
  run(sql, "UPDATE alert_routes SET destination = ?, channel = ?, enabled = ?, updated_by = ?, updated_at = ? WHERE event = ?",
    route.destination, channel, route.enabled ? 1 : 0, viewer.sub, now, route.event);
  return listAlertRoutes(sql, viewer);
}

export function listRules(sql: SqlStorage, viewer: OversightViewer): OversightResult<RuleView[]> {
  const rows = all<{ id: number; scope: RuleView["scope"]; name: string; question: string; action: RuleView["action"]; threshold: number; mode: RuleView["mode"]; enabled: number; version: number }>(sql,
    `SELECT id, scope, name, question, action, threshold, mode, enabled, version FROM rules
     WHERE scope = 'workspace' OR owner_sub = ? ORDER BY scope DESC, id`, viewer.sub);
  return { ok: true, value: rows.map((row) => ({ ...row, id: String(row.id), enabled: row.enabled === 1 })) };
}

export interface RuleInput {
  scope: "workspace" | "user";
  name: string;
  question: string;
  action: "block" | "flag";
  threshold: number;
  enabled: boolean;
}

export const RULE_LIMITS = { workspace: 20, user: 10, nameLength: 80, questionLength: 500 } as const;

function cleanRuleInput(input: Partial<RuleInput>): RuleInput | null {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const question = typeof input.question === "string" ? input.question.trim() : "";
  const threshold = Number(input.threshold);
  if (!name || name.length > RULE_LIMITS.nameLength) return null;
  if (!question || question.length > RULE_LIMITS.questionLength) return null;
  if (input.scope !== "workspace" && input.scope !== "user") return null;
  if (input.action !== "block" && input.action !== "flag") return null;
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) return null;
  return { scope: input.scope, name, question, action: input.action, threshold, enabled: input.enabled !== false };
}

interface StoredRule {
  id: number;
  scope: "workspace" | "user";
  owner_sub: string | null;
}

function canEditRule(viewer: OversightViewer, rule: Pick<StoredRule, "scope" | "owner_sub">): boolean {
  return rule.scope === "workspace" ? viewer.role === "admin" : rule.owner_sub === viewer.sub;
}

export function createRule(sql: SqlStorage, viewer: OversightViewer, input: Partial<RuleInput>, now: number): OversightResult<RuleView[]> {
  const rule = cleanRuleInput(input);
  if (!rule) return invalid;
  const ownerSub = rule.scope === "user" ? viewer.sub : null;
  if (!canEditRule(viewer, { scope: rule.scope, owner_sub: ownerSub })) return { ok: false, error: "not_found" };
  const { count } = one<{ count: number }>(sql,
    "SELECT count(*) AS count FROM rules WHERE scope = ? AND owner_sub IS ?", rule.scope, ownerSub)!;
  if (count >= RULE_LIMITS[rule.scope]) return invalid;
  run(sql,
    `INSERT INTO rules (scope, owner_sub, name, question, action, threshold, enabled, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    rule.scope, ownerSub, rule.name, rule.question, rule.action, rule.threshold, rule.enabled ? 1 : 0, viewer.sub, now);
  return listRules(sql, viewer);
}

export function updateRule(sql: SqlStorage, viewer: OversightViewer, id: string, input: Partial<RuleInput>, now: number): OversightResult<RuleView[]> {
  const stored = one<StoredRule>(sql, "SELECT id, scope, owner_sub FROM rules WHERE id = ?", Number(id));
  if (!stored) return { ok: false, error: "not_found" };
  if (!canEditRule(viewer, stored)) return { ok: false, error: "not_found" };
  const rule = cleanRuleInput({ ...input, scope: stored.scope });
  if (!rule) return invalid;
  run(sql,
    `UPDATE rules SET name = ?, question = ?, action = ?, threshold = ?, enabled = ?, version = version + 1, updated_by = ?, updated_at = ?
     WHERE id = ?`,
    rule.name, rule.question, rule.action, rule.threshold, rule.enabled ? 1 : 0, viewer.sub, now, stored.id);
  return listRules(sql, viewer);
}

export function deleteRule(sql: SqlStorage, viewer: OversightViewer, id: string): OversightResult<RuleView[]> {
  const stored = one<StoredRule>(sql, "SELECT id, scope, owner_sub FROM rules WHERE id = ?", Number(id));
  if (!stored) return { ok: false, error: "not_found" };
  if (!canEditRule(viewer, stored)) return { ok: false, error: "not_found" };
  run(sql, "DELETE FROM rules WHERE id = ?", stored.id);
  return listRules(sql, viewer);
}
