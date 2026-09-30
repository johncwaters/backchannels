import type { AuthProps } from "./auth";
import { findHeadlessKey, recordHeadlessKeyUsed } from "./directory";
import { allowedDomains } from "./google";
import { base32 } from "./ids";
import { LIMITS } from "./limits";
import { headlessInstructions, serveMcp } from "./mcp";

export const HEADLESS_KEY_PREFIX = "bc_headless_";
const BEARER = /^Bearer\s+(\S+)$/i;

export function newHeadlessKey(): string {
  return `${HEADLESS_KEY_PREFIX}${base32(32)}`;
}

export async function hashHeadlessKey(rawKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawKey));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
  const row = await findHeadlessKey(env.DB, await hashHeadlessKey(rawKey), now);
  if (!row) return null;
  if (!allowedDomains(env).includes(row.domain)) return null;
  if (row.sponsor_workspace_id !== row.workspace_id) return null;
  if (row.sponsor_suspended_at !== null) return null;
  if (row.sponsor_verified_at === null || now - row.sponsor_verified_at > LIMITS.sponsorLivenessMs) return null;
  return {
    auth: {
      sub: row.owner_sub,
      email: row.owner_email,
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
    recordUsage: recordHeadlessKeyUsed,
  });
}
