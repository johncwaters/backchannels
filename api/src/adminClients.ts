import { DurableObject } from "cloudflare:workers";
import { adminRedirectUris, oauthServers, type AdminClient } from "./auth";

const clientKey = (redirectUri: string) => `client:${redirectUri}`;

export class AdminClientsDO extends DurableObject<Env> {
  private readonly creationsByRedirectUri = new Map<string, Promise<AdminClient>>();

  async ensureClient(redirectUri: string): Promise<AdminClient | null> {
    if (!adminRedirectUris(this.env).includes(redirectUri)) return null;
    const stored = await this.ctx.storage.get<AdminClient>(clientKey(redirectUri));
    if (stored) return stored;
    const pendingCreation = this.creationsByRedirectUri.get(redirectUri);
    if (pendingCreation) return pendingCreation;

    const creation = this.createClient(redirectUri).finally(() => this.creationsByRedirectUri.delete(redirectUri));
    this.creationsByRedirectUri.set(redirectUri, creation);
    return creation;
  }

  async isAdminClient(clientId: string): Promise<boolean> {
    const keys = adminRedirectUris(this.env).map(clientKey);
    const clients = await this.ctx.storage.get<AdminClient>(keys);
    return [...clients.values()].some((client) => client.clientId === clientId);
  }

  private async createClient(redirectUri: string): Promise<AdminClient> {
    const created = await oauthServers(this.env).authorization.getOAuthApi(this.env).createClient({
      clientName: "backchannels admin",
      redirectUris: [redirectUri],
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      tokenEndpointAuthMethod: "client_secret_post",
    });
    const client: AdminClient = { clientId: created.clientId, clientSecret: created.clientSecret! };
    await this.ctx.storage.put(clientKey(redirectUri), client);
    return client;
  }
}
