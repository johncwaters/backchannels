import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
import { base64url } from "./ids";
import { LIMITS } from "./limits";

// Google is only the sign-in step inside our own OAuth server. The `hd` request
// parameter is a hint, not a control: every check happens on the verified ID token.

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const jwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export interface GoogleIdentity {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
  domain: string;
}

export class GoogleSignInError extends Error {}

export function callbackUrl(env: Env): string {
  return `${env.PUBLIC_URL}/auth/google/callback`;
}

export function allowedDomains(env: Env): string[] {
  return env.ALLOWED_DOMAINS.split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
}

export async function authorizeUrl(env: Env, state: string, verifier: string, nonce: string): Promise<string> {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", callbackUrl(env));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", await s256(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  // Google returns a refresh token only on a consent screen.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  const domains = allowedDomains(env);
  if (domains.length === 1) url.searchParams.set("hd", domains[0]);
  return url.toString();
}

interface TokenResponse {
  id_token?: string;
  refresh_token?: string;
  error?: string;
}

async function tokenRequest(env: Env, body: Record<string, string>): Promise<{ status: number; json: TokenResponse }> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, ...body }),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, json: (await response.json().catch(() => ({}))) as TokenResponse };
}

// Exchanges the callback's code and returns the verified identity and the refresh token.
export async function exchangeCode(
  env: Env,
  code: string,
  verifier: string,
  nonce: string,
): Promise<{ identity: GoogleIdentity; refreshToken: string }> {
  const { status, json } = await tokenRequest(env, {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: callbackUrl(env),
  });
  if (status !== 200 || !json.id_token) throw new GoogleSignInError("Google did not accept the sign-in. Try again.");
  const identity = await verifyIdToken(env, json.id_token, nonce);
  if (!json.refresh_token) throw new GoogleSignInError("Google did not return a refresh token. Try again.");
  return { identity, refreshToken: json.refresh_token };
}

export async function verifyIdToken(env: Env, idToken: string, nonce?: string): Promise<GoogleIdentity> {
  const { payload } = await jwtVerify(idToken, jwks, { issuer: ISSUERS, audience: env.GOOGLE_CLIENT_ID }).catch(() => {
    throw new GoogleSignInError("The Google ID token did not verify.");
  });
  if (nonce !== undefined && payload.nonce !== nonce) throw new GoogleSignInError("The Google sign-in does not match this browser.");
  if (payload.email_verified !== true || typeof payload.email !== "string") {
    throw new GoogleSignInError("This Google account has no verified email address.");
  }
  const domain = typeof payload.hd === "string" ? payload.hd.toLowerCase() : "";
  if (!domain) throw new GoogleSignInError("Sign in with a work Google account. Personal accounts cannot join a workspace.");
  if (!allowedDomains(env).includes(domain)) throw new GoogleSignInError(`${domain} does not have a backchannels workspace.`);
  return {
    sub: payload.sub!,
    email: payload.email,
    name: typeof payload.name === "string" ? payload.name : undefined,
    picture: typeof payload.picture === "string" ? payload.picture : undefined,
    domain,
  };
}

export type RecheckResult =
  | { ok: true; refreshToken?: string }
  | { ok: false; revoke: "invalid_grant" | "hd_mismatch" }
  | { ok: false; revoke: null };

// Asks Google whether this grant's account still exists and is still in `domain`.
// Only `invalid_grant` or a changed `hd` are definitive; anything else is retried later.
export async function recheck(env: Env, refreshToken: string, domain: string): Promise<RecheckResult> {
  let response: { status: number; json: TokenResponse };
  try {
    response = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: refreshToken });
  } catch {
    return { ok: false, revoke: null };
  }
  if (response.json.error === "invalid_grant") return { ok: false, revoke: "invalid_grant" };
  if (response.status !== 200) return { ok: false, revoke: null };
  // The ID token came straight from Google's token endpoint over TLS, so its claims
  // can be read without a signature check (OpenID Connect Core 3.1.3.7).
  if (response.json.id_token) {
    const claims = decodeJwt(response.json.id_token);
    if (typeof claims.hd !== "string" || claims.hd.toLowerCase() !== domain) return { ok: false, revoke: "hd_mismatch" };
  }
  return { ok: true, refreshToken: response.json.refresh_token };
}

export type RecheckDecision =
  | { action: "renew"; refreshToken?: string }
  | { action: "revoke"; reason: "invalid_grant" | "hd_mismatch" }
  | { action: "keep" }
  | { action: "refuse" };

// A transient failure never revokes; past the grace window it only refuses, so an unreachable Google cannot extend access forever.
export function recheckDecision(lastCheckedAt: number, now: number, result: RecheckResult): RecheckDecision {
  if (result.ok) return { action: "renew", refreshToken: result.refreshToken };
  if (result.revoke) return { action: "revoke", reason: result.revoke };
  if (now - lastCheckedAt < LIMITS.googleRecheckGraceMs) return { action: "keep" };
  return { action: "refuse" };
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}
