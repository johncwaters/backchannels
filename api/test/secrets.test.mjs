import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { findSecret, scanFields } from "../src/secrets.ts";

const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const UPPER_ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function randomFrom(alphabet, length) {
  return Array.from(randomBytes(length), (byte) => alphabet[byte % alphabet.length]).join("");
}

const base64url = (bytes) => randomBytes(bytes).toString("base64url");
const join = (...parts) => parts.join("");

const MUST_BE_REFUSED = [
  ["backchannels agent key", join("bc_", "agent_", base64url(32))],
  ["private key", join("-----BEGIN ", "RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA")],
  ["AWS access key", join("AK", "IA", randomFrom(UPPER_ALPHANUMERIC, 16))],
  ["AWS session key", join("AS", "IA", randomFrom(UPPER_ALPHANUMERIC, 16))],
  ["GitHub token", join("gh", "p_", randomFrom(ALPHANUMERIC, 36))],
  ["GitHub fine-grained token", join("github", "_pat_", randomFrom(ALPHANUMERIC, 22), "_", randomFrom(ALPHANUMERIC, 59))],
  ["Anthropic API key", join("sk-", "ant-", base64url(40))],
  ["OpenAI API key", join("sk-", "proj-", base64url(48))],
  ["Stripe secret key", join("sk", "_live_", randomFrom(ALPHANUMERIC, 24))],
  ["Google API key", join("AI", "za", randomFrom(ALPHANUMERIC, 35))],
  ["PostHog personal API key", join("ph", "x_", randomFrom(ALPHANUMERIC, 40))],
  ["chat bot token", join("xo", "xb-", randomFrom("0123456789", 12), "-", randomFrom(ALPHANUMERIC, 24))],
  ["JSON web token", join("ey", "J", base64url(20), ".ey", "J", base64url(30), ".", base64url(32))],
  ["password in a URL", join("postgres://deploy:", randomFrom(ALPHANUMERIC, 12), "@db.internal:5432/app")],
  ["random token", join(randomBytes(30).toString("base64"), "Q7x")],
];

const MUST_PASS = [
  ["git SHA", "fix landed in 3f786850e387550fdab836ed7e6dc881de23001b on main"],
  ["UUID", "request id 123e4567-e89b-12d3-a456-426614174000 failed"],
  ["sha256 hex", "sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"],
  ["Docker digest", "image@sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"],
  ["lockfile integrity", join("integrity: sha512-", randomBytes(64).toString("base64"))],
  ["long identifier", "call handleAuthorizationCodeGrantWithRefreshTokenRotation before retrying"],
  ["file path", "see api/src/search/semantic-leg/crossEncoderScoresWithTimeout.ts line 42"],
  ["URL without password", "docs at https://developers.cloudflare.com/workers/wrangler/commands/#dev"],
  ["PostHog project key", join("ph", "c_", randomFrom(ALPHANUMERIC, 43))],
  ["error message", "TypeError: Cannot read properties of undefined (reading 'workspace_id') at resolveCaller"],
  ["message ID", "the root cause is in deploys/4821/t, see also dm:k7f2/12"],
];

describe("secret scanner", () => {
  for (const [label, secret] of MUST_BE_REFUSED) {
    test(`refuses a ${label}`, () => {
      assert.ok(findSecret(`note: ${secret} is the value`), `${label} passed the scanner`);
    });
  }

  for (const [label, text] of MUST_PASS) {
    test(`allows a ${label}`, () => {
      assert.equal(findSecret(text), null, `${label} was flagged as ${findSecret(text)}`);
    });
  }

  test("the error names the field and the kind of secret, never the value", () => {
    const secret = join("gh", "p_", randomFrom(ALPHANUMERIC, 36));
    const error = scanFields({ text: `token ${secret}` });
    assert.match(error, /^text contains what looks like a secret \(GitHub token\)/);
    assert.ok(!error.includes(secret));
  });

  test("scans every string in an array field", () => {
    assert.ok(scanFields({ keywords: ["deploy", join("AK", "IA", randomFrom(UPPER_ALPHANUMERIC, 16))] }));
  });
});
