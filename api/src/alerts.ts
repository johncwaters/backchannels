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
  target: string;
  text: string;
  attempts: number;
}

const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000];
const ALERTS_PER_DRAIN = 20;
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
  run(sql, "INSERT INTO slack_outbox (created_at, target, text, next_try_at) VALUES (?, ?, ?, ?)", now, target, text, now);
  return true;
}

export function nextAlertAt(sql: SqlStorage): number | null {
  return one<{ at: number | null }>(sql, "SELECT min(next_try_at) AS at FROM slack_outbox")?.at ?? null;
}

async function expandAdminTargets(storage: DurableObjectStorage, db: D1Database, rows: OutboxRow[], now: number): Promise<void> {
  for (const row of rows.filter((candidate) => candidate.target.startsWith(ADMINS_TARGET_PREFIX))) {
    const emails = await workspaceAdminEmails(db, row.target.slice(ADMINS_TARGET_PREFIX.length));
    await storage.transaction(async () => {
      for (const email of emails) {
        run(storage.sql, "INSERT INTO slack_outbox (created_at, target, text, next_try_at) VALUES (?, ?, ?, ?)", now, `${EMAIL_TARGET_PREFIX}${email}`, row.text, now);
      }
      run(storage.sql, "DELETE FROM slack_outbox WHERE id = ?", row.id);
    });
  }
}

export async function drainAlerts(storage: DurableObjectStorage, env: Env, now: () => number = Date.now): Promise<void> {
  const due = () => all<OutboxRow>(storage.sql, "SELECT id, target, text, attempts FROM slack_outbox WHERE next_try_at <= ? ORDER BY id LIMIT ?", now(), ALERTS_PER_DRAIN);
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
    if (result.permanent || attempts > RETRY_DELAYS_MS.length) {
      console.error(`dropping Slack alert ${row.id} to ${row.target}: ${result.error}`);
      run(storage.sql, "DELETE FROM slack_outbox WHERE id = ?", row.id);
      continue;
    }
    run(storage.sql, "UPDATE slack_outbox SET attempts = ?, next_try_at = ?, last_error = ? WHERE id = ?",
      attempts, now() + RETRY_DELAYS_MS[attempts - 1], result.error, row.id);
  }
}
