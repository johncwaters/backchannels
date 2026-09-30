import type { AuthProps } from "./auth";
import { findHeadlessKey, recordHeadlessKeyUsed, type HeadlessKeyRow } from "./directory";
import { allowedDomains } from "./google";
import { base32, sha256Hex, workspaceOwner } from "./ids";
import { isHeadlessKeyInGoodStanding } from "./keyRotation";
import { LIMITS } from "./limits";
import { headlessInstructions, serveMcp } from "./mcp";

export const HEADLESS_KEY_PREFIX = "bc_headless_";
const BEARER = /^Bearer\s+(\S+)$/i;

export function newHeadlessKey(): string {
  return `${HEADLESS_KEY_PREFIX}${base32(32)}`;
}

export function headlessBearer(request: Request): string | null {
  const token = BEARER.exec(request.headers.get("authorization") ?? "")?.[1];
  return token?.startsWith(HEADLESS_KEY_PREFIX) ? token : null;
}

export interface HeadlessSession {
  auth: AuthProps;
  suggestedName: string;
}

export async function resolveHeadlessKey(env: Env, rawKey: string): Promise<HeadlessSession | null> {
  const now = Date.now();
  const row = await findHeadlessKey(env.DB, await sha256Hex(rawKey), now);
  if (!row) return null;
  if (!isHeadlessKeyInGoodStanding(row, allowedDomains(env), now, LIMITS.sponsorLivenessMs)) return null;
  return {
    auth: {
      sub: row.owner_sub,
      email: workspaceOwner(row.workspace_id, row.domain).email,
      workspace_id: row.workspace_id,
      grant_id: row.id,
    },
    suggestedName: row.suggested_name,
  };
}

function invalidToken(): Response {
  return Response.json(
    { error: "invalid_token", error_description: "This headless key is unknown, expired, revoked or suspended. Ask a workspace admin for a new one." },
    { status: 401, headers: { "WWW-Authenticate": 'Bearer error="invalid_token"' } },
  );
}

export async function serveHeadless(request: Request, env: Env, ctx: ExecutionContext, rawKey: string): Promise<Response> {
  const session = await resolveHeadlessKey(env, rawKey);
  if (!session) return invalidToken();
  return serveMcp(request, env, ctx, session.auth, {
    instructions: headlessInstructions(session.suggestedName),
    nudgesSkillUpdates: false,
    recordUsage: recordHeadlessKeyUsed,
  });
}
