import type { GoogleIdentity } from "./google";
import { agentId, workspaceId, workspaceOwner, workspaceOwnerSub } from "./ids";
import { LIMITS } from "./limits";
import type { SponsorState } from "./keyRotation";

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

export interface InstallationRow {
  grant_id: string;
  client_name: string | null;
  created_at: number;
  last_used_at: number;
}

export async function listActiveMcpInstallations(db: D1Database, sub: string, workspaceId: string): Promise<InstallationRow[]> {
  const found = await db
    .prepare(
      `SELECT grant_id, client_name, created_at, last_used_at FROM installations
       WHERE sub = ? AND workspace_id = ? AND kind = 'mcp' AND revoked_at IS NULL ORDER BY last_used_at DESC`,
    )
    .bind(sub, workspaceId)
    .all<InstallationRow>();
  return found.results;
}

export async function isActiveMcpInstallationOf(db: D1Database, grantId: string, sub: string, workspaceId: string): Promise<boolean> {
  const found = await db
    .prepare(
      "SELECT 1 AS found FROM installations WHERE grant_id = ? AND sub = ? AND workspace_id = ? AND kind = 'mcp' AND revoked_at IS NULL",
    )
    .bind(grantId, sub, workspaceId)
    .first<number>("found");
  return found === 1;
}

const lastUsedWrites = new Map<string, number>();

// At most one write per minute per grant (DATA.md, Request resolution).
function isUsageWriteDue(id: string, now: number): boolean {
  if (now - (lastUsedWrites.get(id) ?? 0) < LIMITS.lastUsedWriteMs) return false;
  lastUsedWrites.set(id, now);
  return true;
}

export async function recordUsed(db: D1Database, grantId: string): Promise<void> {
  const now = Date.now();
  if (!isUsageWriteDue(grantId, now)) return;
  await db.prepare("UPDATE installations SET last_used_at = ? WHERE grant_id = ?").bind(now, grantId).run();
}

export async function recordHeadlessKeyUsed(db: D1Database, keyId: string): Promise<void> {
  const now = Date.now();
  if (!isUsageWriteDue(keyId, now)) return;
  await db.prepare("UPDATE headless_keys SET last_used_at = ? WHERE id = ?").bind(now, keyId).run();
}

export interface HeadlessKeyRow {
  id: string;
  workspace_id: string;
  suggested_name: string;
  domain: string;
  owner_sub: string;
  sponsor_workspace_id: string;
  sponsor_verified_at: number | null;
  sponsor_suspended_at: number | null;
}

export async function findHeadlessKey(db: D1Database, keyHash: string, now: number): Promise<HeadlessKeyRow | null> {
  return db
    .prepare(
      `SELECT k.id, k.workspace_id, k.suggested_name, w.domain, o.sub AS owner_sub,
         s.workspace_id AS sponsor_workspace_id, s.last_verified_at AS sponsor_verified_at, s.headless_suspended_at AS sponsor_suspended_at
       FROM headless_keys k
       JOIN workspaces w ON w.id = k.workspace_id
       JOIN carbon_units o ON o.sub = 'workspace:' || k.workspace_id
       JOIN carbon_units s ON s.sub = k.sponsor_sub
       WHERE k.key_hash = ? AND k.revoked_at IS NULL AND k.expires_at > ?`,
    )
    .bind(keyHash, now)
    .first<HeadlessKeyRow>();
}

export async function findWorkspaceDomainOrNull(db: D1Database, workspaceId: string): Promise<string | null> {
  return db.prepare("SELECT domain FROM workspaces WHERE id = ?").bind(workspaceId).first<string>("domain");
}

export async function findWorkspaceDomain(db: D1Database, workspaceId: string): Promise<string> {
  const domain = await findWorkspaceDomainOrNull(db, workspaceId);
  if (!domain) throw new Error(`workspace ${workspaceId} is missing`);
  return domain;
}

export async function ensureWorkspaceOwner(db: D1Database, workspaceId: string): Promise<{ sub: string; email: string }> {
  const workspace = await db.prepare("SELECT domain, name FROM workspaces WHERE id = ?").bind(workspaceId).first<{ domain: string; name: string }>();
  if (!workspace) throw new Error(`workspace ${workspaceId} is missing`);
  const owner = workspaceOwner(workspaceId, workspace.domain);
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO carbon_units (sub, workspace_id, email, name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (sub) DO UPDATE SET email = excluded.email`,
    )
    .bind(owner.sub, workspaceId, owner.email, workspace.name, now, now)
    .run();
  return owner;
}

export async function recordVerified(db: D1Database, sub: string, options: { liftSuspension: boolean }): Promise<void> {
  const suspension = options.liftSuspension ? ", headless_suspended_at = NULL" : "";
  await db.prepare(`UPDATE carbon_units SET last_verified_at = ?${suspension} WHERE sub = ?`).bind(Date.now(), sub).run();
}

export async function suspendHeadlessSponsor(db: D1Database, sub: string): Promise<void> {
  await db
    .prepare("UPDATE carbon_units SET headless_suspended_at = ? WHERE sub = ? AND headless_suspended_at IS NULL")
    .bind(Date.now(), sub)
    .run();
}

export type NewAgentRecord = { ok: true; id: string } | { ok: false; error: string };

export async function createAgentRecord(db: D1Database, owner: { sub: string; workspaceId: string }): Promise<NewAgentRecord> {
  const counts = await db
    .prepare("SELECT SUM(created_at > ?) AS today, SUM(revoked_at IS NULL) AS live FROM agents WHERE owner_sub = ?")
    .bind(Date.now() - 24 * 60 * 60 * 1000, owner.sub)
    .first<{ today: number | null; live: number | null }>();
  const isWorkspaceOwner = owner.sub === workspaceOwnerSub(owner.workspaceId);
  if (isWorkspaceOwner && (counts?.live ?? 0) >= LIMITS.liveAgentsPerWorkspaceOwner) {
    return { ok: false, error: `This workspace has ${LIMITS.liveAgentsPerWorkspaceOwner} live headless agents. Reuse an existing agent name, or ask a workspace admin to revoke one.` };
  }
  if (!isWorkspaceOwner && (counts?.today ?? 0) >= LIMITS.registerAgentPerDay) {
    return { ok: false, error: `Your carbon unit created ${LIMITS.registerAgentPerDay} agents in the last 24 hours. Reuse an existing agent name, or try again tomorrow.` };
  }
  if (!isWorkspaceOwner && (counts?.live ?? 0) >= LIMITS.liveAgentsPerCarbonUnit) {
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
      `SELECT carbon_units.email, carbon_units.name, carbon_units.is_admin, workspaces.name AS workspace_name FROM carbon_units
       JOIN workspaces ON workspaces.id = carbon_units.workspace_id WHERE carbon_units.sub = ? AND carbon_units.workspace_id = ?`,
    )
    .bind(sub, workspaceId)
    .first<{ email: string; name: string | null; is_admin: number; workspace_name: string }>();
}

export async function isWorkspaceAdmin(db: D1Database, sub: string, workspaceId: string): Promise<boolean> {
  const found = await db
    .prepare("SELECT is_admin FROM carbon_units WHERE sub = ? AND workspace_id = ?")
    .bind(sub, workspaceId)
    .first<number>("is_admin");
  return found === 1;
}

export interface HeadlessKeyListing {
  id: string;
  label: string;
  suggested_name: string;
  key_hint: string;
  sponsor_email: string;
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
  rotated_from: string | null;
  has_successor: number;
}

export async function listHeadlessKeys(
  db: D1Database,
  workspaceId: string,
  options: { now: number; before?: { createdAt: number; id: string }; limit: number },
): Promise<HeadlessKeyListing[]> {
  const before = options.before ?? { createdAt: Number.MAX_SAFE_INTEGER, id: "" };
  const found = await db
    .prepare(
      `SELECT k.id, k.label, k.suggested_name, k.key_hint, s.email AS sponsor_email, k.created_at, k.expires_at, k.last_used_at, k.rotated_from,
         EXISTS (SELECT 1 FROM headless_keys n WHERE n.rotated_from = k.id) AS has_successor
       FROM headless_keys k JOIN carbon_units s ON s.sub = k.sponsor_sub
       WHERE k.workspace_id = ? AND k.revoked_at IS NULL AND k.expires_at > ?
         AND (k.created_at < ? OR (k.created_at = ? AND k.id < ?))
       ORDER BY k.created_at DESC, k.id DESC LIMIT ?`,
    )
    .bind(workspaceId, options.now, before.createdAt, before.createdAt, before.id, options.limit)
    .all<HeadlessKeyListing>();
  return found.results;
}

export interface LiveHeadlessKey {
  id: string;
  label: string;
  suggested_name: string;
  created_at: number;
  expires_at: number;
  rotated_from: string | null;
  has_successor: number;
}

export async function findLiveHeadlessKey(db: D1Database, keyId: string, workspaceId: string, now: number): Promise<LiveHeadlessKey | null> {
  return db
    .prepare(
      `SELECT id, label, suggested_name, created_at, expires_at, rotated_from,
         EXISTS (SELECT 1 FROM headless_keys n WHERE n.rotated_from = headless_keys.id) AS has_successor
       FROM headless_keys WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL AND expires_at > ?`,
    )
    .bind(keyId, workspaceId, now)
    .first<LiveHeadlessKey>();
}

export interface NewHeadlessKeyRow {
  id: string;
  workspaceId: string;
  label: string;
  suggestedName: string;
  keyHash: string;
  keyHint: string;
  sponsorSub: string;
  createdAt: number;
  expiresAt: number;
  rotatedFrom: string | null;
}

const HEADLESS_KEY_INSERT_COLUMNS =
  "INSERT INTO headless_keys (id, workspace_id, label, suggested_name, key_hash, key_hint, sponsor_sub, created_at, expires_at, rotated_from)";

function headlessKeyInsertValues(key: NewHeadlessKeyRow): unknown[] {
  return [key.id, key.workspaceId, key.label, key.suggestedName, key.keyHash, key.keyHint, key.sponsorSub, key.createdAt, key.expiresAt, key.rotatedFrom];
}

export async function insertHeadlessKey(db: D1Database, key: NewHeadlessKeyRow): Promise<void> {
  await db
    .prepare(`${HEADLESS_KEY_INSERT_COLUMNS} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(...headlessKeyInsertValues(key))
    .run();
}

function insertSuccessorIfRotatedKeyLiveStatement(
  db: D1Database,
  successor: NewHeadlessKeyRow,
  rotatedKeyId: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `${HEADLESS_KEY_INSERT_COLUMNS}
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM headless_keys WHERE id = ? AND revoked_at IS NULL AND expires_at > ?)`,
    )
    .bind(...headlessKeyInsertValues(successor), rotatedKeyId, now);
}

export type HeadlessKeyRotationOutcome = "rotated" | "already_rotated" | "not_live";

export async function rotateHeadlessKeyRows(
  db: D1Database,
  rotation: { successor: NewHeadlessKeyRow; rotatedKeyId: string; rotatedExpiresAt: number; predecessorId: string | null; now: number },
): Promise<HeadlessKeyRotationOutcome> {
  const successorExists = "EXISTS (SELECT 1 FROM headless_keys WHERE id = ?)";
  const statements = [
    insertSuccessorIfRotatedKeyLiveStatement(db, rotation.successor, rotation.rotatedKeyId, rotation.now),
    db
      .prepare(`UPDATE headless_keys SET expires_at = ? WHERE id = ? AND revoked_at IS NULL AND ${successorExists}`)
      .bind(rotation.rotatedExpiresAt, rotation.rotatedKeyId, rotation.successor.id),
  ];
  if (rotation.predecessorId) {
    statements.push(
      db
        .prepare(`UPDATE headless_keys SET expires_at = MIN(expires_at, ?) WHERE id = ? AND ${successorExists}`)
        .bind(rotation.now, rotation.predecessorId, rotation.successor.id),
    );
  }
  try {
    const [successorInsert] = await db.batch(statements);
    if (successorInsert.meta.changes === 0) return "not_live";
    return "rotated";
  } catch (error) {
    if (isRotatedFromConflict(error)) return "already_rotated";
    throw error;
  }
}

function isRotatedFromConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UNIQUE constraint failed") && message.includes("rotated_from");
}

export async function revokeHeadlessKeyRow(db: D1Database, keyId: string, workspaceId: string): Promise<boolean> {
  const result = await db
    .prepare("UPDATE headless_keys SET revoked_at = ? WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL")
    .bind(Date.now(), keyId, workspaceId)
    .run();
  return result.meta.changes > 0;
}

export async function revokeAgentRecord(db: D1Database, agentId: string, ownerSub: string): Promise<void> {
  await db.prepare("UPDATE agents SET revoked_at = ? WHERE id = ? AND owner_sub = ? AND revoked_at IS NULL").bind(Date.now(), agentId, ownerSub).run();
}

export async function findSponsorState(
  db: D1Database,
  sub: string,
): Promise<SponsorState | null> {
  return db
    .prepare("SELECT last_verified_at, headless_suspended_at FROM carbon_units WHERE sub = ?")
    .bind(sub)
    .first<SponsorState>();
}
