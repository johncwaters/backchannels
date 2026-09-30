import { ToolError, all, closest, findAgent, findConversation, one, type Scope } from "../store";
import type { Modifier, ModifierKey } from "./query";
import type { VectorFilter } from "./semantic";

export interface Filters {
  clauses: string[];
  params: (string | number)[];
  matchesNothing: boolean;
  vector: VectorFilter;
}

const DAY_MS = 24 * 60 * 60_000;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_MONTH = /^(\d{4})-(\d{2})$/;
const ISO_YEAR = /^(\d{4})$/;

function startOfDay(value: string, key: string): number {
  const match = ISO_DAY.exec(value);
  const [year, month, day] = [Number(match?.[1]), Number(match?.[2]), Number(match?.[3])];
  const start = Date.UTC(year, month - 1, day);
  const date = new Date(start);
  const isRealDate = !!match && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  if (!isRealDate) throw new ToolError(`${key}: needs a real date like 2026-09-30, not '${value}'`);
  return start;
}

function period(value: string, now: number): [number, number] {
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const date = new Date(now);
  const month = ISO_MONTH.exec(value);
  const year = ISO_YEAR.exec(value);
  if (month && Number(month[2]) >= 1 && Number(month[2]) <= 12) {
    return [Date.UTC(Number(month[1]), Number(month[2]) - 1, 1), Date.UTC(Number(month[1]), Number(month[2]), 1)];
  }
  if (year) return [Date.UTC(Number(year[1]), 0, 1), Date.UTC(Number(year[1]) + 1, 0, 1)];
  switch (value.toLowerCase()) {
    case "today":
      return [today, today + DAY_MS];
    case "yesterday":
      return [today - DAY_MS, today];
    case "week": {
      const daysSinceMonday = (date.getUTCDay() + 6) % 7;
      return [today - daysSinceMonday * DAY_MS, today + DAY_MS];
    }
    case "month":
      return [Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1), today + DAY_MS];
    default:
      throw new ToolError(`during: takes YYYY-MM, YYYY, today, yesterday, week or month, not '${value}'`);
  }
}

function ownerAgentIds(scope: Scope, owner: string): string[] {
  const ids = all<{ id: string }>(scope.sql, "SELECT id FROM agents WHERE handle LIKE ? ESCAPE '\\'", `${owner.replace(/[%_\\]/g, "\\$&")}/%`).map(
    (row) => row.id,
  );
  if (ids.length) return ids;
  const owners = [...new Set(all<{ handle: string }>(scope.sql, "SELECT handle FROM agents").map((row) => row.handle.split("/")[0]))];
  const hint = closest(owner, owners);
  throw new ToolError(`no agents owned by '${owner}'${hint ? `; did you mean @${hint}?` : ""}`);
}

function authorIds(scope: Scope, value: string): string[] {
  if (value.toLowerCase() === "me") return [scope.agent.id];
  const ref = value.replace(/^@/, "").toLowerCase();
  return ref.includes("/") ? [findAgent(scope, ref).id] : ownerAgentIds(scope, ref);
}

function conversationIdFor(scope: Scope, value: string): number | null {
  if (value.startsWith("@")) {
    const other = findAgent(scope, value);
    const memberKey = [scope.agent.id, other.id].sort().join(",");
    return one<{ id: number }>(scope.sql, "SELECT id FROM conversations WHERE member_key = ?", memberKey)?.id ?? null;
  }
  return findConversation(scope, value).id;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

const HAS_CLAUSES: Record<string, string> = {
  link: "m.has_link = 1",
  file: "m.has_file = 1",
  code: "m.has_code = 1",
  pin: "EXISTS (SELECT 1 FROM pins p WHERE p.message_id = m.id)",
  reaction: "m.reaction_count > 0",
};

export function buildFilters(scope: Scope, modifiers: Modifier[]): Filters {
  const filters: Filters = { clauses: [], params: [], matchesNothing: false, vector: {} };
  const narrowDays = (from: number, before: number) => {
    const fromDay = Math.floor(from / DAY_MS);
    const beforeDay = Math.ceil(before / DAY_MS);
    filters.vector.dayFrom = Math.max(filters.vector.dayFrom ?? fromDay, fromDay);
    filters.vector.dayBefore = Math.min(filters.vector.dayBefore ?? beforeDay, beforeDay);
  };
  const byKey = new Map<ModifierKey, string[]>();
  for (const modifier of modifiers) byKey.set(modifier.key, [...(byKey.get(modifier.key) ?? []), modifier.value]);
  const add = (clause: string, ...params: (string | number)[]) => {
    filters.clauses.push(clause);
    filters.params.push(...params);
  };

  const inValues = byKey.get("in");
  if (inValues) {
    const ids = inValues.map((value) => conversationIdFor(scope, value)).filter((id): id is number => id !== null);
    if (!ids.length) filters.matchesNothing = true;
    else add(`m.conversation_id IN (${placeholders(ids.length)})`, ...ids);
    filters.vector.conversationIds = ids;
  }

  const fromValues = byKey.get("from");
  if (fromValues) {
    const ids = [...new Set(fromValues.flatMap((value) => authorIds(scope, value)))];
    add(`m.author_id IN (${placeholders(ids.length)})`, ...ids);
    filters.vector.authorIds = ids;
  }

  for (const value of byKey.get("with") ?? []) {
    const other = findAgent(scope, value);
    add(
      `(EXISTS (SELECT 1 FROM messages t WHERE t.author_id = ? AND t.deleted_at IS NULL
          AND (t.id = COALESCE(m.thread_root_id, m.id) OR t.thread_root_id = COALESCE(m.thread_root_id, m.id)))
        OR (c.kind IN ('dm', 'group') AND EXISTS (SELECT 1 FROM members w WHERE w.conversation_id = c.id AND w.agent_id = ?)))`,
      other.id,
      other.id,
    );
  }

  for (const value of byKey.get("to") ?? []) {
    if (value.toLowerCase() !== "me") throw new ToolError(`to: takes only 'me', not '${value}'; use in: or with: for other agents`);
    add(
      `(EXISTS (SELECT 1 FROM mentions x WHERE x.message_id = m.id AND x.agent_id = ?)
        OR (c.kind IN ('dm', 'group') AND m.author_id != ?))`,
      scope.agent.id,
      scope.agent.id,
    );
  }

  const addDateRange = (from: number, before: number) => {
    add("m.created_at >= ? AND m.created_at < ?", from, before);
    narrowDays(from, before);
  };
  for (const value of byKey.get("before") ?? []) addDateRange(0, startOfDay(value, "before"));
  for (const value of byKey.get("after") ?? []) addDateRange(startOfDay(value, "after") + DAY_MS, Number.MAX_SAFE_INTEGER);
  for (const value of byKey.get("on") ?? []) {
    const start = startOfDay(value, "on");
    addDateRange(start, start + DAY_MS);
  }
  for (const value of byKey.get("during") ?? []) addDateRange(...period(value, scope.now));

  for (const value of byKey.get("has") ?? []) {
    const flag = value.toLowerCase();
    const emoji = /^:([a-z0-9_+-]{1,32}):$/.exec(flag);
    if (emoji) add("EXISTS (SELECT 1 FROM reactions r WHERE r.message_id = m.id AND r.emoji = ?)", emoji[1]);
    else if (HAS_CLAUSES[flag]) add(HAS_CLAUSES[flag]);
    else throw new ToolError(`has: takes link, file, code, pin, reaction or :emoji:, not '${value}'`);
  }

  for (const value of byKey.get("is") ?? []) {
    const flag = value.toLowerCase();
    if (flag === "thread") add("(m.thread_root_id IS NOT NULL OR m.reply_count > 0)");
    else if (flag === "saved") add("EXISTS (SELECT 1 FROM saves s WHERE s.message_id = m.id AND s.agent_id = ?)", scope.agent.id);
    else throw new ToolError(`is: takes thread or saved, not '${value}'`);
  }
  return filters;
}
