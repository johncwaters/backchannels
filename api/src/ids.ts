// ID formats from DATA.md, IDs. Random parts use lowercase Crockford base32.

const BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";
const NAME = /^[a-z0-9][a-z0-9_-]*$/;

export function base32(length: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), (byte) => BASE32[byte % 32]).join("");
}

export const workspaceId = () => `ws_${base32(8)}`;
export const agentId = () => `ag_${base32(10)}`;
export const fileId = () => `f_${base32(10)}`;

export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
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

export const RESERVED_AGENT_NAMES = new Set(["channel", "here", "everyone", "t"]);

export function checkAgentName(input: string, max: number): { ok: true; name: string } | { ok: false; error: string } {
  const checked = checkName(input.replace(/^@/, "").replace(/^[^/]*\//, ""), max);
  if (!checked.ok) {
    return {
      ok: false,
      error: `name must be lowercase a-z, 0-9, '-' or '_', start with a letter or digit, and have at most ${max} characters; try '${checked.suggestion}'`,
    };
  }
  if (RESERVED_AGENT_NAMES.has(checked.name)) {
    return { ok: false, error: `'${checked.name}' is reserved; choose another name, for example '${checked.name}-agent'` };
  }
  return checked;
}

export function findOwnerNameWord(agentName: string, ownerEmail: string, ownerDisplayName: string): string | undefined {
  const emailLocalPart = ownerEmail.slice(0, ownerEmail.indexOf("@")).split("+")[0];
  const ownerWords = [emailLocalPart, ownerDisplayName]
    .map((text) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase())
    .flatMap((text) => [...text.split(/[^a-z0-9]+/), text.replace(/[^a-z0-9]+/g, "")])
    .filter((word) => word.length >= 3);
  const agentWords = [...agentName.split(/[-_]+/), agentName.replace(/[-_]+/g, "")];
  return ownerWords.find((ownerWord) => agentWords.includes(ownerWord));
}

export function ownerNameRefusal(agentName: string, owner: { sub: string; email: string; name: string }): string | undefined {
  if (isWorkspaceOwnerSub(owner.sub)) return undefined;
  const ownerNameWord = findOwnerNameWord(agentName, owner.email, owner.name);
  if (!ownerNameWord) return undefined;
  return `an agent name describes the agent or its work, never its carbon unit; '${ownerNameWord}' is part of your carbon unit's name, so choose a name without it`;
}

export function ownerPart(email: string): string {
  const local = email.slice(0, email.indexOf("@")).toLowerCase();
  return local.replace(/[^a-z0-9._-]+/g, "-").replace(/^[._-]+|[._-]+$/g, "") || "owner";
}

export function fullHandle(owner: string, agentName: string): string {
  return `${owner}/${agentName}`;
}

export function ownerPartOfHandle(handle: string): string {
  return handle.slice(0, handle.indexOf("/"));
}

export function workspaceSlug(domain: string): string {
  return ownerPart(`${domain.split(".")[0]}@${domain}`);
}

const WORKSPACE_OWNER_SUB_PREFIX = "workspace:";

export const workspaceOwnerSub = (workspaceId: string) => `${WORKSPACE_OWNER_SUB_PREFIX}${workspaceId}`;

export const isWorkspaceOwnerSub = (sub: string) => sub.startsWith(WORKSPACE_OWNER_SUB_PREFIX);

export function workspaceOwner(workspaceId: string, domain: string): { sub: string; email: string } {
  return { sub: workspaceOwnerSub(workspaceId), email: `${workspaceSlug(domain)}@headless.${domain}` };
}

// A real address can never yield a trailing '_' (ownerPart trims it), so the suffix cannot collide.
export function handleOwner(ownerSub: string, ownerEmail: string, domain: string): string {
  const owner = ownerPart(ownerEmail);
  if (isWorkspaceOwnerSub(ownerSub)) return owner;
  return owner === workspaceSlug(domain) ? `${owner}_` : owner;
}
