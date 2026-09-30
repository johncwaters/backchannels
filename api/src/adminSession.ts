import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { AdminResult, AdminSession, Installation } from "./admin";
import { adminClient, adminResource, isAdminClient, oauthServers, type AdminClient, type AuthProps } from "./auth";
import { isActiveMcpInstallationOf, listActiveMcpInstallations, recordRevoked, recordUsed } from "./directory";

const unauthorized = { ok: false, error: "unauthorized" } as const;
const invalid = { ok: false, error: "invalid" } as const;
const notFound = { ok: false, error: "not_found" } as const;

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

export interface AdminIdentity {
  sub: string;
  workspaceId: string;
  grantId: string;
}

export async function authenticateAdmin(env: Env, ctx: ExecutionContext, token: unknown): Promise<AdminIdentity | null> {
  if (!isText(token)) return null;
  const validated = await oauthServers(env).authorization.validateToken<AuthProps>(adminResource(env), token, env);
  if (!validated || !(await isAdminClient(env, validated.clientId))) return null;
  ctx.waitUntil(recordUsed(env.DB, validated.props.grant_id));
  return { sub: validated.props.sub, workspaceId: validated.props.workspace_id, grantId: validated.props.grant_id };
}

export async function adminSignInUrl(
  env: Env,
  input: { redirectUri: string; state: string; codeChallenge: string },
): Promise<AdminResult<string>> {
  if (!isText(input?.redirectUri) || !isText(input.state) || !isText(input.codeChallenge)) return invalid;
  const client = await adminClient(env, input.redirectUri);
  if (!client) return invalid;
  const query = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: input.redirectUri,
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    resource: adminResource(env),
  });
  return { ok: true, value: `${env.PUBLIC_URL}/auth/authorize?${query}` };
}

function postToTokenEndpoint(env: Env, ctx: ExecutionContext, client: AdminClient, fields: Record<string, string>): Promise<Response> {
  const body = new URLSearchParams({ ...fields, client_id: client.clientId, client_secret: client.clientSecret });
  const request = new Request(`${env.PUBLIC_URL}/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  return oauthServers(env).authorization.fetch(request, env, ctx);
}

async function requestSession(
  env: Env,
  ctx: ExecutionContext,
  client: AdminClient,
  fields: Record<string, string>,
): Promise<AdminResult<AdminSession>> {
  const response = await postToTokenEndpoint(env, ctx, client, { ...fields, resource: adminResource(env) });
  if (!response.ok) return unauthorized;
  const tokens = await response.json<{ access_token?: string; refresh_token?: string; expires_in?: number }>();
  if (!tokens.access_token || !tokens.refresh_token || !tokens.expires_in) return unauthorized;
  return {
    ok: true,
    value: { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + tokens.expires_in * 1000 },
  };
}

export async function exchangeAdminCode(
  env: Env,
  ctx: ExecutionContext,
  input: { code: string; codeVerifier: string; redirectUri: string },
): Promise<AdminResult<AdminSession>> {
  if (!isText(input?.code) || !isText(input.codeVerifier) || !isText(input.redirectUri)) return invalid;
  const client = await adminClient(env, input.redirectUri);
  if (!client) return invalid;
  return requestSession(env, ctx, client, {
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: input.redirectUri,
  });
}

export async function refreshAdminSession(
  env: Env,
  ctx: ExecutionContext,
  input: { refreshToken: string; redirectUri: string },
): Promise<AdminResult<AdminSession>> {
  if (!isText(input?.refreshToken) || !isText(input.redirectUri)) return invalid;
  const client = await adminClient(env, input.redirectUri);
  if (!client) return invalid;
  return requestSession(env, ctx, client, { grant_type: "refresh_token", refresh_token: input.refreshToken });
}

async function hasGrant(oauth: OAuthHelpers, userId: string, grantId: string, clientId?: string): Promise<boolean> {
  let cursor: string | undefined;
  do {
    const page = await oauth.listUserGrants(userId, { cursor });
    if (page.items.some((grant) => grant.id === grantId && (clientId === undefined || grant.clientId === clientId))) return true;
    cursor = page.cursor;
  } while (cursor);
  return false;
}

export async function revokeAdminSession(
  env: Env,
  ctx: ExecutionContext,
  input: { refreshToken: string; redirectUri: string },
): Promise<AdminResult<null>> {
  if (!isText(input?.refreshToken) || !isText(input.redirectUri)) return invalid;
  const client = await adminClient(env, input.redirectUri);
  if (!client) return invalid;
  const [userId, grantId] = input.refreshToken.split(":");
  if (!userId || !grantId) return unauthorized;

  const oauth = oauthServers(env).authorization.getOAuthApi(env);
  if (!(await hasGrant(oauth, userId, grantId, client.clientId))) return unauthorized;
  const attemptRevocation = async (): Promise<boolean> => {
    try {
      await postToTokenEndpoint(env, ctx, client, { token: input.refreshToken, token_type_hint: "refresh_token" });
      return !(await hasGrant(oauth, userId, grantId, client.clientId));
    } catch (error) {
      console.error("Revoking an admin grant failed", error);
      return false;
    }
  };
  const isRevoked = (await attemptRevocation()) || (await attemptRevocation());
  if (!isRevoked) throw new Error("The admin grant survived two revocation attempts.");
  ctx.waitUntil(recordRevoked(env.DB, grantId, "user"));
  return { ok: true, value: null };
}

export async function listInstallations(env: Env, identity: AdminIdentity): Promise<AdminResult<{ installations: Installation[] }>> {
  const rows = await listActiveMcpInstallations(env.DB, identity.sub, identity.workspaceId);
  const installations = rows.map((row) => ({
    grantId: row.grant_id,
    clientName: row.client_name,
    createdAt: new Date(row.created_at).toISOString(),
    lastUsedAt: new Date(row.last_used_at).toISOString(),
  }));
  return { ok: true, value: { installations } };
}

export async function revokeInstallation(
  env: Env,
  identity: AdminIdentity,
  input: { grantId: string },
): Promise<AdminResult<null>> {
  if (!isText(input?.grantId)) return invalid;
  const { grantId } = input;
  if (!(await isActiveMcpInstallationOf(env.DB, grantId, identity.sub, identity.workspaceId))) return notFound;
  const oauth = oauthServers(env).authorization.getOAuthApi(env);
  await oauth.revokeGrant(grantId, identity.sub);
  if (await hasGrant(oauth, identity.sub, grantId)) throw new Error("The installation's grant survived revocation.");
  await recordRevoked(env.DB, grantId, "user");
  return { ok: true, value: null };
}
