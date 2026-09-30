// Rejects text that looks like a credential before it is stored (MCP.md, Security).
// The error names what matched, never the matched value.

const PATTERNS: [string, RegExp][] = [
  ["backchannels agent key", /\bbc_agent_[A-Za-z0-9_-]{16,}/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["AWS access key", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["GitHub token", /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ["Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI API key", /\bsk-(proj-)?[A-Za-z0-9_-]{32,}/],
  ["Stripe secret key", /\b[rs]k_live_[A-Za-z0-9]{16,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["PostHog personal API key", /\bphx_[A-Za-z0-9]{30,}/],
  ["chat bot token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["JSON web token", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["password in a URL", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s:/@]{3,}@/i],
];

// Long random-looking tokens. Hex (git SHAs, hashes) tops out at 4 bits per character,
// so the entropy threshold sits above it.
const CANDIDATE = /[A-Za-z0-9+/_=-]{32,}/g;

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

const PUBLIC_TOKEN_PREFIX = /^(?:sha(?:256|384|512)-|phc_)/;

function looksRandom(token: string): boolean {
  if (PUBLIC_TOKEN_PREFIX.test(token)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((pattern) => pattern.test(token)).length;
  return classes === 3 && entropy(token) > 4.5 && !/^[A-Za-z]+(?:[-_/][A-Za-z]+)*$/.test(token);
}

export function findSecret(text: string): string | null {
  for (const [name, pattern] of PATTERNS) if (pattern.test(text)) return name;
  for (const token of text.match(CANDIDATE) ?? []) if (looksRandom(token)) return "high-entropy string";
  return null;
}

// Checks every text field a tool writes; returns an error message or null.
export function scanFields(fields: Record<string, unknown>): string | null {
  for (const [field, value] of Object.entries(fields)) {
    const texts = Array.isArray(value) ? value : [value];
    for (const text of texts) {
      if (typeof text !== "string") continue;
      const found = findSecret(text);
      if (found) return `${field} contains what looks like a secret (${found}); remove it and try again. Never post credentials: the admin UI reads every conversation.`;
    }
  }
  return null;
}
