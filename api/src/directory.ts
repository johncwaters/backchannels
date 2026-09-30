import type { GoogleIdentity } from "./google";
import { agentId, randomToken, sha256Hex, workspaceId } from "./ids";
import { LIMITS } from "./limits";

// D1 access for the directory (DATA.md, D1): workspaces, carbon units,
// installations, and agent key hashes. Agent profiles live in the workspace object.

const AGENT_KEY_PREFIX = "bc_agent_";

// The first sign-in from an allowed domain creates its workspace.
export async function recordSignIn(db: D1Database, identity: GoogleIdentity): Promise<string> {
  const now = Date.now();
  await db
    .prepare("INSERT INTO workspaces (id, domain, name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (domain) DO NOTHING")
    .bind(workspaceId(), identity.domain, identity.domain, now)
    .run();
  const workspace = await db.prepare("SELECT id FROM workspaces WHERE domain = ?").bind(identity.domain).first<string>("id");
  if (!workspace) throw new Error(`workspace for ${identity.domain} is missing`);
  await db
    .prepare(
      `INSERT INTO carbon_units (sub, workspace_id, email, name, picture, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (sub) DO UPDATE SET workspace_id = excluded.workspace_id, email = excluded.email, name = excluded.name,
         picture = excluded.picture, last_seen_at = excluded.last_seen_at`,
    )
    .bind(identity.sub, workspace, identity.email, identity.name ?? null, identity.picture ?? null, now, now)
    .run();
  return workspace;
}

// Called when the grant's code is exchanged, the first point where its grant ID is known.
export async function recordInstallation(
  db: D1Database,
  installation: { grantId: string; sub: string; workspaceId: string; clientId: string; clientName?: string; kind: "mcp" | "admin" },
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO installations (grant_id, sub, workspace_id, client_id, client_name, kind, created_at, last_used_at, last_checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (grant_id) DO NOTHING`,
    )
    .bind(
      installation.grantId,
      installation.sub,
      installation.workspaceId,
      installation.clientId,
      installation.clientName ?? null,
      installation.kind,
      now,
      now,
      now,
    )
    .run();
}

export async function recordChecked(db: D1Database, grantId: string): Promise<void> {
  await db.prepare("UPDATE installations SET last_checked_at = ? WHERE grant_id = ?").bind(Date.now(), grantId).run();
}

export async function recordRevoked(db: D1Database, grantId: string, reason: string): Promise<void> {
  await db
    .prepare("UPDATE installations SET revoked_at = ?, revoked_reason = ? WHERE grant_id = ? AND revoked_at IS NULL")
    .bind(Date.now(), reason, grantId)
    .run();
}

const lastUsedWrites = new Map<string, number>();

// At most one write per minute per grant (DATA.md, Request resolution).
export async function recordUsed(db: D1Database, grantId: string): Promise<void> {
  const now = Date.now();
  if (now - (lastUsedWrites.get(grantId) ?? 0) < LIMITS.lastUsedWriteMs) return;
  lastUsedWrites.set(grantId, now);
  await db.prepare("UPDATE installations SET last_used_at = ? WHERE grant_id = ?").bind(now, grantId).run();
}

export type NewAgentKey = { ok: true; id: string; key: string } | { ok: false; error: string };

// Creates the agent's auth row and returns its key, shown once; only the hash is kept.
export async function createAgentKey(db: D1Database, owner: { sub: string; workspaceId: string }): Promise<NewAgentKey> {
  const counts = await db
    .prepare(
      `SELECT SUM(created_at > ?) AS today, SUM(revoked_at IS NULL) AS live FROM agents WHERE owner_sub = ?`,
    )
    .bind(Date.now() - 24 * 60 * 60 * 1000, owner.sub)
    .first<{ today: number | null; live: number | null }>();
  if ((counts?.today ?? 0) >= LIMITS.registerAgentPerDay) {
    return { ok: false, error: `Your agents registered ${LIMITS.registerAgentPerDay} times in the last 24 hours. Reuse a saved agent key, or try again tomorrow.` };
  }
  if ((counts?.live ?? 0) >= LIMITS.liveAgentsPerCarbonUnit) {
    return { ok: false, error: `You have ${LIMITS.liveAgentsPerCarbonUnit} live agents. Reuse a saved agent key, or revoke an agent in the admin UI.` };
  }
  const id = agentId();
  const key = AGENT_KEY_PREFIX + randomToken(32);
  await db
    .prepare("INSERT INTO agents (id, workspace_id, owner_sub, key_hash, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, owner.workspaceId, owner.sub, await sha256Hex(key), Date.now())
    .run();
  return { ok: true, id, key };
}

export async function deleteAgentKey(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM agents WHERE id = ?").bind(id).run();
}

const keyCache = new Map<string, { agentId: string; expires: number }>();

// An agent key works only with its owner's OAuth token, in its owner's workspace.
// Successful lookups are cached for a minute, so a revocation lands within a minute.
export async function findAgentId(db: D1Database, key: string, owner: { sub: string; workspaceId: string }): Promise<string | null> {
  if (!key.startsWith(AGENT_KEY_PREFIX)) return null;
  const hash = await sha256Hex(key);
  const cacheKey = `${hash}:${owner.sub}`;
  const cached = keyCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.agentId;

  const id = await db
    .prepare("SELECT id FROM agents WHERE key_hash = ? AND owner_sub = ? AND workspace_id = ? AND revoked_at IS NULL")
    .bind(hash, owner.sub, owner.workspaceId)
    .first<string>("id");
  if (id) keyCache.set(cacheKey, { agentId: id, expires: Date.now() + LIMITS.agentKeyCacheMs });
  return id;
}
