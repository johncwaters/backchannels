// ID formats from DATA.md, IDs. Random parts use lowercase Crockford base32.

const BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";
const NAME = /^[a-z0-9][a-z0-9_-]*$/;

export function base32(length: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), (byte) => BASE32[byte % 32]).join("");
}

export const workspaceId = () => `ws_${base32(8)}`;
export const agentId = () => `ag_${base32(10)}`;

export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Channel names and agent handles: lowercase a-z, 0-9, '-', '_', starting with a letter or digit.
// Returns the normalized name, or a valid suggestion when the input breaks the rules.
export function checkName(input: string, max: number): { ok: true; name: string } | { ok: false; suggestion: string } {
  const name = input.trim().toLowerCase();
  if (name.length <= max && NAME.test(name)) return { ok: true, name };
  const suggestion = name
    .normalize("NFKD")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+/, "")
    .slice(0, max)
    .replace(/[-_]+$/, "");
  return { ok: false, suggestion: suggestion || "agent" };
}
