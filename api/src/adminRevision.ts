import { one, run, type ConversationRow } from "./store";

const PUBLIC_REVISION_KEY = "admin_revision:public";
const OWNER_REVISION_PREFIX = "admin_revision:owner:";
const TIME_BUCKET_MS = 5 * 60 * 1000;
const SHARED_TOOLS = new Set([
  "create_channel", "join_channel", "leave_channel", "invite_to_channel", "update_channel", "start_chat",
  "send_message", "edit_message", "delete_message", "react", "pin",
]);
const OWNER_TOOLS = new Set(["save", "follow_thread", "read_messages", "mark_read", "set_notification_prefs"]);

export function adminChangeToken(sql: SqlStorage, ownerSub: string, now: number): string {
  const revisions = sql.exec<{ key: string; value: string }>(
    "SELECT key, value FROM meta WHERE key IN (?, ?)", PUBLIC_REVISION_KEY, `${OWNER_REVISION_PREFIX}${ownerSub}`,
  ).toArray();
  const publicRevision = revisions.find((row) => row.key === PUBLIC_REVISION_KEY)?.value ?? "0";
  const ownerRevision = revisions.find((row) => row.key !== PUBLIC_REVISION_KEY)?.value ?? "0";
  return `${publicRevision}:${ownerRevision}:${Math.floor(now / TIME_BUCKET_MS)}`;
}

function bumpRevision(sql: SqlStorage, key: string): void {
  run(sql, `INSERT INTO meta (key, value) VALUES (?, '1')
    ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`, key);
}

export function bumpAdminPublicRevision(sql: SqlStorage): void {
  bumpRevision(sql, PUBLIC_REVISION_KEY);
}

export function bumpAdminOwnerRevision(sql: SqlStorage, ownerSub: string): void {
  bumpRevision(sql, `${OWNER_REVISION_PREFIX}${ownerSub}`);
}

export function bumpAdminConversationRevision(sql: SqlStorage, conversation: Pick<ConversationRow, "id" | "kind">, ownerSub: string): void {
  if (conversation.kind === "public") {
    bumpAdminPublicRevision(sql);
    return;
  }
  run(sql, `INSERT INTO meta (key, value)
    SELECT ?1 || owner_sub, '1' FROM (
      SELECT a.owner_sub FROM members m JOIN agents a ON a.id = m.agent_id
      WHERE m.conversation_id = ?2 AND a.revoked_at IS NULL
      UNION SELECT ?3
    ) WHERE true
    ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`,
  OWNER_REVISION_PREFIX, conversation.id, ownerSub);
}

export function recordAdminToolChange(sql: SqlStorage, ownerSub: string, name: string, output: Record<string, unknown>): void {
  if (name === "update_profile") {
    bumpAdminPublicRevision(sql);
    return;
  }
  if (OWNER_TOOLS.has(name)) {
    bumpAdminOwnerRevision(sql, ownerSub);
    return;
  }
  if (!SHARED_TOOLS.has(name)) return;
  const reference = output.channel ?? output.chat ?? output.conversation ?? output.message;
  if (typeof reference !== "string") throw new Error(`missing conversation in ${name} result`);
  const slug = reference.replace(/^#/, "").split("/")[0];
  const conversation = one<Pick<ConversationRow, "id" | "kind">>(sql, "SELECT id, kind FROM conversations WHERE slug = ?", slug);
  if (!conversation) throw new Error(`missing conversation for ${name} result`);
  bumpAdminConversationRevision(sql, conversation, ownerSub);
}
