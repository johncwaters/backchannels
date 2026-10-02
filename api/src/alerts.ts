import { workspaceAdminEmails } from "./directory";
import { postToSlack } from "./slack";
import { all, one, run } from "./store";

export type AlertEvent = "escalation" | "escalation_for_moderators" | "report" | "repeated_blocks" | "checker_down";

interface RouteRow {
  destination: "owner" | "admins" | "channel";
  channel: string | null;
  enabled: number;
}

interface OutboxRow {
  id: number;
  event: string | null;
  target: string;
  text: string;
  attempts: number;
}

const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000];
const ALERTS_PER_DRAIN = 20;
const FAILED_ALERTS_KEPT = 50;
const ADMINS_TARGET_PREFIX = "admins:";
const EMAIL_TARGET_PREFIX = "email:";
const CHANNEL_TARGET_PREFIX = "channel:";

export function oversightUrl(env: Env, path = "/oversight"): string {
  const callback = env.ADMIN_REDIRECT_URIS.split(",")[0]?.trim();
  return callback ? new URL(path, callback).toString() : path;
}

export function queueAlert(
  sql: SqlStorage,
  event: AlertEvent,
  recipients: { ownerEmail?: string; workspaceId: string },
  text: string,
  now: number,
): boolean {
  const route = one<RouteRow>(sql, "SELECT destination, channel, enabled FROM alert_routes WHERE event = ?", event);
  if (!route?.enabled) return false;
  const target = route.destination === "channel" ? `${CHANNEL_TARGET_PREFIX}${route.channel}`
    : route.destination === "admins" ? `${ADMINS_TARGET_PREFIX}${recipients.workspaceId}`
    : recipients.ownerEmail ? `${EMAIL_TARGET_PREFIX}${recipients.ownerEmail}` : null;
  if (!target) return false;
  run(sql, "INSERT INTO slack_outbox (created_at, event, target, text, next_try_at) VALUES (?, ?, ?, ?, ?)", now, event, target, text, now);
  return true;
}

export function nextAlertAt(sql: SqlStorage): number | null {
  return one<{ at: number | null }>(sql, "SELECT min(next_try_at) AS at FROM slack_outbox WHERE failed_at IS NULL")?.at ?? null;
}

async function expandAdminTargets(storage: DurableObjectStorage, db: D1Database, rows: OutboxRow[], now: number): Promise<void> {
  for (const row of rows.filter((candidate) => candidate.target.startsWith(ADMINS_TARGET_PREFIX))) {
    const emails = await workspaceAdminEmails(db, row.target.slice(ADMINS_TARGET_PREFIX.length));
    await storage.transaction(async () => {
      for (const email of emails) {
        run(storage.sql, "INSERT INTO slack_outbox (created_at, event, target, text, next_try_at) VALUES (?, ?, ?, ?, ?)", now, row.event, `${EMAIL_TARGET_PREFIX}${email}`, row.text, now);
      }
      run(storage.sql, "DELETE FROM slack_outbox WHERE id = ?", row.id);
    });
  }
}

export async function drainAlerts(storage: DurableObjectStorage, env: Env, now: () => number = Date.now): Promise<void> {
  const due = () => all<OutboxRow>(storage.sql, "SELECT id, event, target, text, attempts FROM slack_outbox WHERE failed_at IS NULL AND next_try_at <= ? ORDER BY id LIMIT ?", now(), ALERTS_PER_DRAIN);
  await expandAdminTargets(storage, env.DB, due(), now());
  for (const row of due()) {
    const destination = row.target.startsWith(EMAIL_TARGET_PREFIX)
      ? { email: row.target.slice(EMAIL_TARGET_PREFIX.length) }
      : { channel: row.target.slice(CHANNEL_TARGET_PREFIX.length) };
    const result = await postToSlack(env.SLACK_BOT_TOKEN, destination, row.text);
    if (result.ok) {
      run(storage.sql, "DELETE FROM slack_outbox WHERE id = ?", row.id);
      continue;
    }
    const attempts = row.attempts + 1;
    console.error(`Slack alert ${row.id} to ${row.target} failed (attempt ${attempts}): ${result.error}`);
    if (result.permanent || attempts > RETRY_DELAYS_MS.length) {
      console.error(`giving up on Slack alert ${row.id} to ${row.target}: ${result.error}`);
      run(storage.sql, "UPDATE slack_outbox SET attempts = ?, failed_at = ?, last_error = ? WHERE id = ?", attempts, now(), result.error, row.id);
      run(storage.sql, "DELETE FROM slack_outbox WHERE failed_at IS NOT NULL AND id NOT IN (SELECT id FROM slack_outbox WHERE failed_at IS NOT NULL ORDER BY id DESC LIMIT ?)", FAILED_ALERTS_KEPT);
      continue;
    }
    run(storage.sql, "UPDATE slack_outbox SET attempts = ?, next_try_at = ?, last_error = ? WHERE id = ?",
      attempts, now() + RETRY_DELAYS_MS[attempts - 1], result.error, row.id);
  }
}

export interface AlertFailure {
  at: string;
  target: string;
  error: string;
}

export function lastAlertFailures(sql: SqlStorage): Map<string, AlertFailure> {
  const rows = all<{ event: string; failed_at: number; target: string; last_error: string }>(sql,
    `SELECT event, max(failed_at) AS failed_at, target, last_error FROM slack_outbox
     WHERE failed_at IS NOT NULL AND event IS NOT NULL GROUP BY event`);
  return new Map(rows.map((row) => [row.event, { at: new Date(row.failed_at).toISOString(), target: row.target.replace(/^(email|channel):/, ""), error: row.last_error }]));
}
