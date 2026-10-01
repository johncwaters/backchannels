import { findWorkspaceDomainOrNull, isActiveMcpInstallationOf } from "./directory";
import { allowedDomains } from "./google";
import { BASE32, base32 } from "./ids";
import { isHeadlessKeyInGoodStanding, type HeadlessKeyStanding } from "./keyRotation";
import { LIMITS } from "./limits";

export const STREAM_PROTOCOL = "bc-stream";
export const STREAM_TICKET_PREFIX = "bc_stream_";
export const STREAM_ROUTE = /^\/stream\/([A-Za-z0-9_-]{1,64})$/;
const STREAM_TICKET_RANDOM_LENGTH = 32;
const STREAM_TICKET_SHAPE = new RegExp(`^${STREAM_TICKET_PREFIX}[${BASE32}]{${STREAM_TICKET_RANDOM_LENGTH}}$`);

export function newStreamTicket(): string {
  return `${STREAM_TICKET_PREFIX}${base32(STREAM_TICKET_RANDOM_LENGTH)}`;
}

export function streamUrl(publicUrl: string, workspaceId: string): string {
  return `${publicUrl}/stream/${workspaceId}`;
}

export function streamTicketFrom(request: Request): string | null {
  const offeredProtocols = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((protocol) => protocol.trim());
  if (!offeredProtocols.includes(STREAM_PROTOCOL)) return null;
  return offeredProtocols.find((protocol) => STREAM_TICKET_SHAPE.test(protocol)) ?? null;
}

export function streamResumeFrom(request: Request): { canResume: boolean; cursor?: number } {
  const offeredProtocols = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((protocol) => protocol.trim());
  const cursorProtocol = offeredProtocols.find((protocol) => /^bc-resume\.[0-9]{1,15}$/.test(protocol));
  if (cursorProtocol) return { canResume: true, cursor: Number(cursorProtocol.slice("bc-resume.".length)) };
  return { canResume: offeredProtocols.includes("bc-resume") };
}

export function isWebSocketUpgrade(request: Request): boolean {
  return request.method === "GET" && request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

export interface StreamGrant {
  grantId: string;
  ownerSub: string;
  workspaceId: string;
}

async function findLiveHeadlessKeyStanding(db: D1Database, keyId: string, workspaceId: string, now: number): Promise<HeadlessKeyStanding | null> {
  return db
    .prepare(
      `SELECT k.workspace_id, w.domain,
         s.workspace_id AS sponsor_workspace_id, s.last_verified_at AS sponsor_verified_at, s.headless_suspended_at AS sponsor_suspended_at
       FROM headless_keys k
       JOIN workspaces w ON w.id = k.workspace_id
       JOIN carbon_units s ON s.sub = k.sponsor_sub
       WHERE k.id = ? AND k.workspace_id = ? AND k.revoked_at IS NULL AND k.expires_at > ?`,
    )
    .bind(keyId, workspaceId, now)
    .first<HeadlessKeyStanding>();
}

export async function isStreamGrantLive(env: Env, grant: StreamGrant, now: number): Promise<boolean> {
  const [isLiveInstallation, headlessKeyStanding] = await Promise.all([
    isActiveMcpInstallationOf(env.DB, grant.grantId, grant.ownerSub, grant.workspaceId),
    findLiveHeadlessKeyStanding(env.DB, grant.grantId, grant.workspaceId, now),
  ]);
  if (isLiveInstallation) return true;
  return headlessKeyStanding !== null && isHeadlessKeyInGoodStanding(headlessKeyStanding, allowedDomains(env), now, LIMITS.sponsorLivenessMs);
}

export const unauthorizedStream = () => new Response("unknown, expired or revoked stream ticket\n", { status: 401 });

export async function openStream(request: Request, env: Env, workspaceId: string): Promise<Response> {
  if (!isWebSocketUpgrade(request)) return new Response("expected a WebSocket upgrade\n", { status: 426, headers: { upgrade: "websocket" } });
  if (!streamTicketFrom(request)) return unauthorizedStream();
  if ((await findWorkspaceDomainOrNull(env.DB, workspaceId)) === null) return unauthorizedStream();
  return env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId)).fetch(request);
}
