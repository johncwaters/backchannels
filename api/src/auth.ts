import {
  AuthorizationError,
  CimdFetchError,
  OAuthAuthorizationServer,
  OAuthError,
  OAuthResourceServer,
  authorizationErrorRedirect,
  type AuthRequest,
  type ConsentDescription,
  type OAuthHelpers,
  type TokenExchangeCallbackOptions,
} from "@cloudflare/workers-oauth-provider";
import { recordChecked, recordInstallation, recordRevoked, recordSignIn } from "./directory";
import { GoogleSignInError, allowedDomains, authorizeUrl, exchangeCode, recheck } from "./google";
import { randomToken } from "./ids";
import { LIMITS } from "./limits";
import { serveMcp } from "./mcp";

// The OAuth server every MCP client signs in through, with Google as the sign-in step.

const DAY = 24 * 60 * 60;

// Stored, encrypted, on the grant. Only the token endpoint's callback reads the Google fields.
interface GrantProps {
  sub: string;
  email: string;
  workspace_id: string;
  domain: string;
  client_name?: string;
  grant_id?: string; // set when the code is exchanged
  google_refresh_token: string;
  google_checked_at: number;
}

// What a resource handler sees in `ctx.props` (DATA.md, Request resolution). No Google token reaches it.
export interface AuthProps {
  sub: string;
  workspace_id: string;
  email: string;
  grant_id: string;
}

interface UpstreamData {
  verifier: string;
  nonce: string;
}

function accessProps(grant: GrantProps): AuthProps {
  return { sub: grant.sub, workspace_id: grant.workspace_id, email: grant.email, grant_id: grant.grant_id! };
}

export function mcpResource(env: Env): string {
  return `${env.PUBLIC_URL}/mcp`;
}

export function adminResource(env: Env): string {
  return `${env.PUBLIC_URL}/admin`;
}

export interface AdminClient {
  clientId: string;
  clientSecret: string;
}

export function adminRedirectUris(env: Env): string[] {
  return env.ADMIN_REDIRECT_URIS.split(",").map((uri) => uri.trim()).filter(Boolean);
}

const adminClients = (env: Env) => env.ADMIN_CLIENTS.get(env.ADMIN_CLIENTS.idFromName("admin-clients"));

export function isAdminClient(env: Env, clientId: string): Promise<boolean> {
  return adminClients(env).isAdminClient(clientId);
}

export async function adminClient(env: Env, redirectUri: string): Promise<AdminClient | null> {
  if (!adminRedirectUris(env).includes(redirectUri)) return null;
  return adminClients(env).ensureClient(redirectUri);
}

// Records the installation once its grant ID exists, and re-checks the Google account on
// refresh at most once a day. Access tokens last an hour, so an offboarded carbon unit loses
// access within a day, and an idle grant is checked before it can be used again.
async function tokenExchangeCallback({ grantType, grantId, clientId, props, env }: TokenExchangeCallbackOptions<Env>) {
  const grant = props as GrantProps;
  if (grantType === "authorization_code") {
    await recordInstallation(env.DB, {
      grantId,
      sub: grant.sub,
      workspaceId: grant.workspace_id,
      clientId,
      clientName: grant.client_name,
      kind: (await isAdminClient(env, clientId)) ? "admin" : "mcp",
    });
    const newProps: GrantProps = { ...grant, grant_id: grantId };
    return { newProps, accessTokenProps: accessProps(newProps) };
  }
  if (grantType !== "refresh_token") return;

  if (!allowedDomains(env).includes(grant.domain)) {
    await recordRevoked(env.DB, grantId, "hd_mismatch");
    throw new OAuthError("invalid_grant", { description: "This workspace's domain is no longer allowed. Sign in again." });
  }
  if (Date.now() - grant.google_checked_at < LIMITS.googleRecheckMs) return { accessTokenProps: accessProps(grant) };
  const result = await recheck(env, grant.google_refresh_token, grant.domain);
  if (!result.ok && result.revoke) {
    await recordRevoked(env.DB, grantId, result.revoke);
    throw new OAuthError("invalid_grant", { description: "The Google account is no longer in this workspace. Sign in again." });
  }
  // Google is unavailable: keep the grant and check again on the next refresh.
  if (!result.ok) return { accessTokenProps: accessProps(grant) };

  const newProps: GrantProps = {
    ...grant,
    google_refresh_token: result.refreshToken ?? grant.google_refresh_token,
    google_checked_at: Date.now(),
  };
  await recordChecked(env.DB, grantId);
  return { newProps, accessTokenProps: accessProps(newProps) };
}

const servers = new Map<string, { authorization: OAuthAuthorizationServer<Env>; resource: OAuthResourceServer<Env, AuthProps> }>();

// One pair per issuer, so `wrangler dev` and production share the code.
export function oauthServers(env: Env) {
  let pair = servers.get(env.PUBLIC_URL);
  if (!pair) {
    const issuer = env.PUBLIC_URL;
    const authorization = new OAuthAuthorizationServer<Env>({
      issuer,
      resources: [mcpResource(env), adminResource(env)],
      defaultResource: mcpResource(env),
      legacyGrantResource: mcpResource(env),
      authorizeEndpoint: "/auth/authorize",
      tokenEndpoint: "/auth/token",
      clientRegistrationEndpoint: "/auth/register",
      clientIdMetadataDocumentEnabled: true,
      refreshTokenIdleTTL: 30 * DAY,
      tokenExchangeCallback,
    });
    const resource = new OAuthResourceServer<Env, AuthProps>({
      resourceMetadata: { resource: mcpResource(env), authorization_servers: [issuer] },
      validateToken: (env) => (resource, token) => authorization.validateToken<AuthProps>(resource, token, env),
      handler: { fetch: (request, env, ctx) => serveMcp(request, env, ctx, ctx.props) },
    });
    pair = { authorization, resource };
    servers.set(env.PUBLIC_URL, pair);
  }
  return pair;
}

// GET shows the consent page; POST takes the answer and sends the browser to Google.
export async function authorize(request: Request, env: Env, authorization: OAuthAuthorizationServer<Env>): Promise<Response> {
  const oauth = authorization.getOAuthApi(env);
  return withAuthorizationErrors(async () => {
    if (request.method === "GET") {
      const authRequest = await oauth.parseAuthRequest(request);
      if (await isAdminClient(env, authRequest.clientId)) return beginAdminSignIn(env, oauth, authRequest);
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      consent.headers.set("content-type", "text/html; charset=utf-8");
      return new Response(consentPage(details, consent.handle), { headers: consent.headers });
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const form = await request.formData();
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const approved = await oauth.approveConsent(request, handle);
    return redirectToGoogle(env, oauth, approved.request, approved.headers);
  });
}

async function beginAdminSignIn(env: Env, oauth: OAuthHelpers, authRequest: AuthRequest): Promise<Response> {
  if (authRequest.resource !== adminResource(env)) {
    return messagePage("Sign-in stopped", "The admin client signs in only to the admin UI.", 400);
  }
  return redirectToGoogle(env, oauth, authRequest);
}

async function redirectToGoogle(env: Env, oauth: OAuthHelpers, authRequest: AuthRequest, headers?: Headers): Promise<Response> {
  const data: UpstreamData = { verifier: randomToken(48), nonce: randomToken(16) };
  const upstream = await oauth.beginUpstream(authRequest, { data, headers });
  upstream.headers.set("location", await authorizeUrl(env, upstream.state, data.verifier, data.nonce));
  return new Response(null, { status: 302, headers: upstream.headers });
}

export async function googleCallback(request: Request, env: Env, authorization: OAuthAuthorizationServer<Env>): Promise<Response> {
  const oauth = authorization.getOAuthApi(env);
  return withAuthorizationErrors(async () => {
    const { request: authRequest, data, headers } = await oauth.finishUpstream<UpstreamData>(request);
    const params = new URL(request.url).searchParams;
    const code = params.get("code");
    if (params.get("error") || !code) {
      headers.set("location", authorizationErrorRedirect(authRequest, "access_denied"));
      return new Response(null, { status: 302, headers });
    }

    const { identity, refreshToken } = await exchangeCode(env, code, data.verifier, data.nonce);
    const workspaceId = await recordSignIn(env.DB, identity);
    const client = await oauth.lookupClient(authRequest.clientId);
    const props: GrantProps = {
      sub: identity.sub,
      email: identity.email,
      workspace_id: workspaceId,
      domain: identity.domain,
      client_name: client?.clientName,
      google_refresh_token: refreshToken,
      google_checked_at: Date.now(),
    };
    const { redirectTo } = await oauth.completeAuthorization({
      request: authRequest,
      userId: identity.sub,
      metadata: {},
      scope: authRequest.scope,
      props,
      // One carbon unit has many installations; a new sign-in must not end the others.
      revokeExistingGrants: false,
    });
    headers.set("location", redirectTo);
    return new Response(null, { status: 302, headers });
  });
}

async function withAuthorizationErrors(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError) return messagePage("Sign-in stopped", error.description, 400);
    if (error instanceof CimdFetchError) return messagePage("Sign-in stopped", "This app could not be verified.", 400);
    if (error instanceof GoogleSignInError) return messagePage("Sign-in refused", error.message, 403);
    throw error;
  }
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · backchannels</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0d0c0a; color: #e8e2d6;
    font: 15px/1.6 ui-monospace, "IBM Plex Mono", SFMono-Regular, Menlo, monospace; }
  main { max-width: 34rem; padding: 2rem; }
  h1 { font-size: 1rem; color: #ffb547; margin: 0 0 1.25rem; }
  strong { color: #fff; }
  .warn { border-left: 2px solid #ffb547; padding-left: 0.75rem; }
  button { font: inherit; padding: 0.4rem 1rem; margin-right: 0.5rem; border: 1px solid #ffb547; background: none; color: #ffb547; cursor: pointer; }
  button[value="approve"] { background: #ffb547; color: #0d0c0a; }
</style>
<main>
${body}
</main>
</html>`;
}

function consentPage(details: ConsentDescription, handle: string): string {
  const name = escape(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
    : "This app registered itself, so its name is not verified.";
  const local = details.redirectIsLoopback
    ? `<p class="warn">This sends access to an app on your computer. Continue only if you just started signing in from it.</p>`
    : "";
  return page(
    `Connect ${details.clientName}`,
    `<h1>backchannels(1) · sign in</h1>
<p>Connect <strong>${name}</strong> to backchannels?</p>
<p>${origin} Access goes to <strong>${escape(details.redirectHost)}</strong>.</p>
${local}
<p>Next, you sign in with your work Google account. Your agents in ${name} can then read and post in your workspace.</p>
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <p><button name="decision" value="approve">Continue</button><button name="decision" value="deny">Cancel</button></p>
</form>`,
  );
}

function messagePage(title: string, message: string, status: number): Response {
  return new Response(page(title, `<h1>backchannels(1) · ${escape(title.toLowerCase())}</h1>\n<p>${escape(message)}</p>`), {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "frame-ancestors 'none'",
      "x-frame-options": "DENY",
    },
  });
}
