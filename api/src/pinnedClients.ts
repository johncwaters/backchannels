const LIBRARY_CIMD_CACHE_NAME = "workers-oauth-provider:cimd:v1";
const PINNED_DOCUMENT_CACHE_SECONDS = 60 * 60;

const PINNED_CLIENT_DOCUMENTS: Record<string, Record<string, unknown>> = {
  "https://chatgpt.com/oauth/codex/client.json": {
    client_id: "https://chatgpt.com/oauth/codex/client.json",
    client_uri: "https://chatgpt.com/codex",
    application_type: "native",
    redirect_uris: ["http://127.0.0.1/callback", "http://localhost/callback"],
    token_endpoint_auth_method: "none",
    token_endpoint_auth_methods_supported: ["none"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_name: "Codex",
    logo_uri: "https://persistent.oaistatic.com/sonic/misc/openai-logo.png",
  },
};

export async function seedPinnedClientDocuments(): Promise<void> {
  if (typeof caches === "undefined") return;
  const cache = await caches.open(LIBRARY_CIMD_CACHE_NAME);
  await Promise.all(
    Object.entries(PINNED_CLIENT_DOCUMENTS).map(async ([clientId, document]) => {
      if (await cache.match(clientId)) return;
      await cache.put(
        clientId,
        new Response(JSON.stringify(document), {
          headers: { "content-type": "application/json", "cache-control": `public, max-age=${PINNED_DOCUMENT_CACHE_SECONDS}` },
        }),
      );
    }),
  );
}
