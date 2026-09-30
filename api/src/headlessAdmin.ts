import type { AdminResult, HeadlessAgent, HeadlessKey, NewHeadlessKey } from "./admin";
import type { AdminIdentity } from "./adminSession";
import {
  ensureWorkspaceOwner,
  findLiveHeadlessKey,
  findSponsorState,
  insertHeadlessKey,
  isWorkspaceAdmin,
  listHeadlessKeys,
  revokeAgentRecord,
  revokeHeadlessKeyRow,
  rotateHeadlessKeyRows,
  type NewHeadlessKeyRow,
} from "./directory";
import { hashHeadlessKey, newHeadlessKey } from "./headless";
import { base32, checkAgentName, workspaceOwnerSub } from "./ids";
import { expiresAtFor, expiryDaysFrom, isSponsorLive, overlapExpiry, successorExpiry } from "./keyRotation";
import { LIMITS } from "./limits";

const unauthorized = { ok: false, error: "unauthorized" } as const;
const invalid = { ok: false, error: "invalid" } as const;
const notFound = { ok: false, error: "not_found" } as const;

const headlessKeyId = () => `hk_${base32(10)}`;
const iso = (at: number) => new Date(at).toISOString();

function workspaceStub(env: Env, identity: AdminIdentity) {
  return env.WORKSPACE.get(env.WORKSPACE.idFromName(identity.workspaceId));
}

async function isAdmin(env: Env, identity: AdminIdentity): Promise<boolean> {
  return isWorkspaceAdmin(env.DB, identity.sub, identity.workspaceId);
}

async function canSponsorKeys(env: Env, identity: AdminIdentity, now: number): Promise<boolean> {
  const sponsor = await findSponsorState(env.DB, identity.sub);
  return sponsor !== null && isSponsorLive(sponsor, now, LIMITS.sponsorLivenessMs);
}

const sponsorNotVerified = { ok: false, error: "sponsor_not_verified" } as const;

async function newKeyRow(
  identity: AdminIdentity,
  fields: { label: string; suggestedName: string; expiresAt: number; rotatedFrom: string | null; now: number },
): Promise<{ row: NewHeadlessKeyRow; key: string }> {
  const key = newHeadlessKey();
  const row: NewHeadlessKeyRow = {
    id: headlessKeyId(),
    workspaceId: identity.workspaceId,
    label: fields.label,
    suggestedName: fields.suggestedName,
    keyHash: await hashHeadlessKey(key),
    keyHint: key.slice(-4),
    sponsorSub: identity.sub,
    createdAt: fields.now,
    expiresAt: fields.expiresAt,
    rotatedFrom: fields.rotatedFrom,
  };
  return { row, key };
}

export async function listHeadlessKeysFor(
  env: Env,
  identity: AdminIdentity,
  options: { cursor?: string },
): Promise<AdminResult<{ keys: HeadlessKey[]; agents: HeadlessAgent[]; nextCursor?: string }>> {
  if (!(await isAdmin(env, identity))) return unauthorized;
  const [cursorCreatedAt, cursorId] = (options?.cursor ?? "").split(":");
  const before = cursorId ? { createdAt: Number(cursorCreatedAt), id: cursorId } : undefined;
  const limit = LIMITS.headlessKeysPerPage;
  const rows = await listHeadlessKeys(env.DB, identity.workspaceId, { now: Date.now(), before, limit });
  const keys = rows.map((row) => ({
    id: row.id,
    label: row.label,
    suggestedName: row.suggested_name,
    keyHint: row.key_hint,
    sponsorEmail: row.sponsor_email,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    lastUsedAt: row.last_used_at === null ? null : iso(row.last_used_at),
    rotatedFrom: row.rotated_from,
    hasSuccessor: row.has_successor === 1,
  }));
  const last = rows.at(-1);
  const nextCursor = rows.length === limit && last ? `${last.created_at}:${last.id}` : undefined;
  const agentRows = await workspaceStub(env, identity).ownerAgents(workspaceOwnerSub(identity.workspaceId));
  const agents = agentRows.map((agent) => ({ handle: `@${agent.handle}`, description: agent.description, lastActiveAt: iso(agent.last_active_at) }));
  return { ok: true, value: { keys, agents, nextCursor } };
}

export async function createHeadlessKeyFor(
  env: Env,
  identity: AdminIdentity,
  input: { label: string; suggestedName: string; expiresInDays: number },
): Promise<AdminResult<NewHeadlessKey>> {
  if (!(await isAdmin(env, identity))) return unauthorized;
  const label = typeof input?.label === "string" ? input.label.trim() : "";
  if (!label || label.length > LIMITS.headlessKeyLabelLength) return invalid;
  const checkedName = checkAgentName(typeof input.suggestedName === "string" ? input.suggestedName : "", LIMITS.handleLength);
  if (!checkedName.ok) return invalid;
  const days = expiryDaysFrom(input.expiresInDays, LIMITS.headlessKeyMaxDays);
  if (days === null) return invalid;
  const now = Date.now();
  if (!(await canSponsorKeys(env, identity, now))) return sponsorNotVerified;
  await ensureWorkspaceOwner(env.DB, identity.workspaceId);
  const { row, key } = await newKeyRow(identity, {
    label,
    suggestedName: checkedName.name,
    expiresAt: expiresAtFor(now, days),
    rotatedFrom: null,
    now,
  });
  await insertHeadlessKey(env.DB, row);
  return { ok: true, value: { keyId: row.id, key, label: row.label } };
}

export async function rotateHeadlessKeyFor(env: Env, identity: AdminIdentity, input: { keyId: string }): Promise<AdminResult<NewHeadlessKey>> {
  if (!(await isAdmin(env, identity))) return unauthorized;
  if (typeof input?.keyId !== "string" || !input.keyId) return invalid;
  const now = Date.now();
  if (!(await canSponsorKeys(env, identity, now))) return sponsorNotVerified;
  const rotated = await findLiveHeadlessKey(env.DB, input.keyId, identity.workspaceId, now);
  if (!rotated) return notFound;
  if (rotated.has_successor === 1) return { ok: false, error: "already_rotated" };
  const { row, key } = await newKeyRow(identity, {
    label: rotated.label,
    suggestedName: rotated.suggested_name,
    expiresAt: successorExpiry(rotated, now, LIMITS.headlessKeyMaxDays),
    rotatedFrom: rotated.id,
    now,
  });
  const rotationOutcome = await rotateHeadlessKeyRows(env.DB, {
    successor: row,
    rotatedKeyId: rotated.id,
    rotatedExpiresAt: overlapExpiry(rotated.expires_at, now, LIMITS.headlessKeyOverlapMs),
    predecessorId: rotated.rotated_from,
    now,
  });
  if (rotationOutcome === "not_live") return notFound;
  if (rotationOutcome === "already_rotated") return { ok: false, error: "already_rotated" };
  return { ok: true, value: { keyId: row.id, key, label: row.label } };
}

export async function revokeHeadlessKeyFor(env: Env, identity: AdminIdentity, input: { keyId: string }): Promise<AdminResult<null>> {
  if (!(await isAdmin(env, identity))) return unauthorized;
  if (typeof input?.keyId !== "string" || !input.keyId) return invalid;
  if (!(await revokeHeadlessKeyRow(env.DB, input.keyId, identity.workspaceId))) return notFound;
  return { ok: true, value: null };
}

export async function revokeHeadlessAgentFor(env: Env, identity: AdminIdentity, input: { handle: string }): Promise<AdminResult<null>> {
  if (!(await isAdmin(env, identity))) return unauthorized;
  if (typeof input?.handle !== "string" || !input.handle) return invalid;
  const owner = workspaceOwnerSub(identity.workspaceId);
  const agentId = await workspaceStub(env, identity).revokeOwnerAgent(owner, input.handle.replace(/^@/, ""), identity.grantId);
  if (!agentId) return notFound;
  await revokeAgentRecord(env.DB, agentId, owner);
  return { ok: true, value: null };
}
