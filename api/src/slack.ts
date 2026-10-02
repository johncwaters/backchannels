const SLACK_API = "https://slack.com/api";
const SLACK_TIMEOUT_MS = 5_000;

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type SlackResult = { ok: true } | { ok: false; error: string; permanent: boolean };

function slackError(method: string, response: { error?: string; needed?: unknown; provided?: unknown }, fallback: string): string {
  const scopes = response.needed ? ` (needed ${String(response.needed)}; token has ${String(response.provided ?? "none")})` : "";
  return `${method}: ${response.error ?? fallback}${scopes}`;
}

const PERMANENT_ERRORS = new Set(["users_not_found", "channel_not_found", "not_in_channel", "is_archived", "invalid_auth", "account_inactive", "missing_scope"]);

async function slackCall(token: string, method: string, body: Record<string, string>, fetchImpl: FetchLike): Promise<{ ok: boolean; error?: string; [key: string]: unknown }> {
  const response = await fetchImpl(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
  });
  if (response.status === 429) return { ok: false, error: "ratelimited" };
  if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
  return response.json();
}

export async function postToSlack(
  token: string | undefined,
  destination: { email: string } | { channel: string },
  text: string,
  fetchImpl: FetchLike = fetch,
): Promise<SlackResult> {
  if (!token) return { ok: false, error: "SLACK_BOT_TOKEN is not set", permanent: false };
  try {
    let channel: string;
    if ("email" in destination) {
      const lookup = await slackCall(token, "users.lookupByEmail", { email: destination.email }, fetchImpl);
      const userId = (lookup.user as { id?: string } | undefined)?.id;
      if (!lookup.ok || !userId) return { ok: false, error: slackError("users.lookupByEmail", lookup, "no user id"), permanent: PERMANENT_ERRORS.has(lookup.error ?? "") };
      channel = userId;
    } else {
      channel = destination.channel;
    }
    const posted = await slackCall(token, "chat.postMessage", { channel, text, unfurl_links: "false" }, fetchImpl);
    if (!posted.ok) return { ok: false, error: slackError("chat.postMessage", posted, "unknown"), permanent: PERMANENT_ERRORS.has(posted.error ?? "") };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), permanent: false };
  }
}
