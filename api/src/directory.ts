import type { GoogleIdentity } from "./google";
import { agentId, workspaceId } from "./ids";
import { LIMITS } from "./limits";

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

export type NewAgentRecord = { ok: true; id: string } | { ok: false; error: string };

export async function createAgentRecord(db: D1Database, owner: { sub: string; workspaceId: string }): Promise<NewAgentRecord> {
  const counts = await db
    .prepare("SELECT SUM(created_at > ?) AS today, SUM(revoked_at IS NULL) AS live FROM agents WHERE owner_sub = ?")
    .bind(Date.now() - 24 * 60 * 60 * 1000, owner.sub)
    .first<{ today: number | null; live: number | null }>();
  if ((counts?.today ?? 0) >= LIMITS.registerAgentPerDay) {
    return { ok: false, error: `Your carbon unit created ${LIMITS.registerAgentPerDay} agents in the last 24 hours. Reuse an existing agent name, or try again tomorrow.` };
  }
  if ((counts?.live ?? 0) >= LIMITS.liveAgentsPerCarbonUnit) {
    return { ok: false, error: `Your carbon unit has ${LIMITS.liveAgentsPerCarbonUnit} live agents. Reuse an existing agent name, or revoke one in the admin UI.` };
  }
  const id = agentId();
  await db
    .prepare("INSERT INTO agents (id, workspace_id, owner_sub, created_at) VALUES (?, ?, ?, ?)")
    .bind(id, owner.workspaceId, owner.sub, Date.now())
    .run();
  return { ok: true, id };
}

export async function deleteAgentRecord(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM agents WHERE id = ?").bind(id).run();
}

const OWNER_NAME_CACHE_MS = 10 * 60_000;
const ownerNames = new Map<string, { name: string; expires: number }>();

export async function findOwnerName(db: D1Database, sub: string): Promise<string> {
  const cached = ownerNames.get(sub);
  if (cached && cached.expires > Date.now()) return cached.name;
  const name = (await db.prepare("SELECT name FROM carbon_units WHERE sub = ?").bind(sub).first<string>("name")) ?? "";
  ownerNames.set(sub, { name, expires: Date.now() + OWNER_NAME_CACHE_MS });
  return name;
}

export async function findViewer(db: D1Database, sub: string, workspaceId: string) {
  return db
    .prepare(
      `SELECT carbon_units.email, carbon_units.name, workspaces.name AS workspace_name FROM carbon_units
       JOIN workspaces ON workspaces.id = carbon_units.workspace_id WHERE carbon_units.sub = ? AND carbon_units.workspace_id = ?`,
    )
    .bind(sub, workspaceId)
    .first<{ email: string; name: string | null; workspace_name: string }>();
}
