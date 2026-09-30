import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { AdminResult, AdminSession } from "./admin";
import { adminClient, adminResource, isAdminClient, oauthServers, type AdminClient, type AuthProps } from "./auth";
import { recordRevoked, recordUsed } from "./directory";

const unauthorized = { ok: false, error: "unauthorized" } as const;
const invalid = { ok: false, error: "invalid" } as const;

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

async function hasGrant(oauth: OAuthHelpers, userId: string, grantId: string, clientId: string): Promise<boolean> {
  let cursor: string | undefined;
  do {
    const page = await oauth.listUserGrants(userId, { cursor });
    if (page.items.some((grant) => grant.id === grantId && grant.clientId === clientId)) return true;
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
  await postToTokenEndpoint(env, ctx, client, { token: input.refreshToken, token_type_hint: "refresh_token" });
  if (await hasGrant(oauth, userId, grantId, client.clientId)) return unauthorized;
  await recordRevoked(env.DB, grantId, "user");
  return { ok: true, value: null };
}
