import { askJeeves, type YesNoQuestion } from "./jeeves";
import { all, one, run } from "./store";

export type RuleSubjectKind = "message" | "edit" | "channel" | "agent";
type RuleAction = "block" | "flag";
type RuleOutcome = "pass" | RuleAction | "unchecked";

interface RuleRow {
  id: number;
  name: string;
  question: string;
  action: RuleAction;
  threshold: number;
  mode: "shadow" | "enforce";
  version: number;
}

interface PendingCheck {
  id: number;
  subject_kind: RuleSubjectKind;
  subject_id: string;
  author_id: string;
  text: string;
  context: string;
  attempts: number;
}

export interface RuleVerdict {
  rule: number;
  version: number;
  name: string;
  action: RuleAction;
  mode: "shadow" | "enforce";
  threshold: number;
  probability: number;
}

const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000];
const CHECKS_PER_DRAIN = 20;
const CHECKER_DOWN_ALERT_AFTER_MS = 10 * 60_000;
const FAILING_SINCE_KEY = "rule_checker_failing_since";
const DOWN_ALERTED_KEY = "rule_checker_down_alerted";

export function queueRuleCheck(
  sql: SqlStorage,
  check: { kind: RuleSubjectKind; subject: string; authorId: string; text: string; context: Record<string, unknown> },
  now: number,
): void {
  if (!check.text.trim()) return;
  run(sql,
    `INSERT INTO rule_checks (subject_kind, subject_id, author_id, text, context, created_at, next_try_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    check.kind, check.subject, check.authorId, check.text, JSON.stringify(check.context), now, now);
}

export function hasPendingRuleChecks(sql: SqlStorage): boolean {
  return !!one(sql, "SELECT 1 AS pending FROM rule_checks WHERE checked_at IS NULL LIMIT 1");
}

export function nextRuleCheckAt(sql: SqlStorage): number | null {
  return one<{ at: number | null }>(sql, "SELECT min(next_try_at) AS at FROM rule_checks WHERE checked_at IS NULL")?.at ?? null;
}

function rulesFor(sql: SqlStorage, authorId: string): RuleRow[] {
  return all<RuleRow>(sql,
    `SELECT id, name, question, action, threshold, mode, version FROM rules
     WHERE enabled = 1 AND (scope = 'workspace' OR owner_sub = (SELECT owner_sub FROM agents WHERE id = ?))
     ORDER BY id`,
    authorId);
}

function outcomeOf(verdicts: RuleVerdict[]): RuleOutcome {
  const triggered = verdicts.filter((verdict) => verdict.probability >= verdict.threshold);
  if (triggered.some((verdict) => verdict.action === "block")) return "block";
  if (triggered.some((verdict) => verdict.action === "flag")) return "flag";
  return "pass";
}

function setMeta(sql: SqlStorage, key: string, value: string): void {
  run(sql, "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
}

export interface CheckerDownSignal {
  failingSinceMs: number;
}

function noteCheckerHealth(sql: SqlStorage, healthy: boolean, now: number): CheckerDownSignal | null {
  if (healthy) {
    run(sql, "DELETE FROM meta WHERE key IN (?, ?)", FAILING_SINCE_KEY, DOWN_ALERTED_KEY);
    return null;
  }
  const since = Number(one<{ value: string }>(sql, "SELECT value FROM meta WHERE key = ?", FAILING_SINCE_KEY)?.value ?? now);
  setMeta(sql, FAILING_SINCE_KEY, String(since));
  if (now - since < CHECKER_DOWN_ALERT_AFTER_MS) return null;
  if (one(sql, "SELECT 1 AS alerted FROM meta WHERE key = ?", DOWN_ALERTED_KEY)) return null;
  setMeta(sql, DOWN_ALERTED_KEY, String(now));
  return { failingSinceMs: since };
}

export async function drainRuleChecks(
  storage: DurableObjectStorage,
  apiKey: string | undefined,
  onCheckerDown: (signal: CheckerDownSignal) => void,
  now: () => number = Date.now,
): Promise<void> {
  const due = all<PendingCheck>(storage.sql,
    "SELECT id, subject_kind, subject_id, author_id, text, context, attempts FROM rule_checks WHERE checked_at IS NULL AND next_try_at <= ? ORDER BY next_try_at LIMIT ?",
    now(), CHECKS_PER_DRAIN);
  for (const check of due) {
    const rules = rulesFor(storage.sql, check.author_id);
    const questions = new Map<string, YesNoQuestion>(rules.map((rule) => [`r${rule.id}`, { instructions: rule.question }]));
    const author = one<{ handle: string }>(storage.sql, "SELECT handle FROM agents WHERE id = ?", check.author_id);
    const state = { kind: check.subject_kind, author: author ? `@${author.handle}` : "unknown", ...JSON.parse(check.context), text: check.text };
    const result = await askJeeves(apiKey, state, questions);
    const checkedAt = now();
    await storage.transaction(async () => {
      if (result.ok) {
        const verdicts: RuleVerdict[] = rules.map((rule) => ({
          rule: rule.id, version: rule.version, name: rule.name, action: rule.action, mode: rule.mode,
          threshold: rule.threshold, probability: result.probabilities.get(`r${rule.id}`)!,
        }));
        run(storage.sql, "UPDATE rule_checks SET checked_at = ?, outcome = ?, verdicts = ?, latency_ms = ?, attempts = attempts + 1 WHERE id = ?",
          checkedAt, outcomeOf(verdicts), JSON.stringify(verdicts), result.latencyMs, check.id);
        noteCheckerHealth(storage.sql, true, checkedAt);
        return;
      }
      console.error(`rule check ${check.id} failed: ${result.error}`);
      const attempts = check.attempts + 1;
      if (attempts > RETRY_DELAYS_MS.length) {
        run(storage.sql, "UPDATE rule_checks SET checked_at = ?, outcome = 'unchecked', attempts = ? WHERE id = ?", checkedAt, attempts, check.id);
      } else {
        run(storage.sql, "UPDATE rule_checks SET attempts = ?, next_try_at = ? WHERE id = ?", attempts, checkedAt + RETRY_DELAYS_MS[attempts - 1], check.id);
      }
      const down = noteCheckerHealth(storage.sql, false, checkedAt);
      if (down) onCheckerDown(down);
    });
    if (!result.ok) break;
  }
}
