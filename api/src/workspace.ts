import { DurableObject } from "cloudflare:workers";
import { LIMITS } from "./limits";
import { MIGRATIONS } from "./schema";

// One per workspace (DATA.md, Durable Object). Everything inside a workspace lives here.

export interface AgentProfile {
  id: string;
  handle: string;
  name: string;
  description: string;
  ownerSub: string;
  ownerEmail: string;
}

export class WorkspaceDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate(): void {
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const row = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'").toArray()[0];
    const version = row ? Number(row.value) : 0;
    for (let next = version; next < MIGRATIONS.length; next++) {
      this.ctx.storage.transactionSync(() => {
        // The first migration also declares meta, which the runner has already made.
        this.sql.exec(MIGRATIONS[next].replace(/CREATE TABLE meta\b/, "CREATE TABLE IF NOT EXISTS meta"));
        this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", String(next + 1));
      });
    }
  }

  async health(): Promise<boolean> {
    return this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM messages_fts").one().n >= 0;
  }

  // Stores the profile under the first free handle: `base`, then `base-2`, `base-3`…
  async registerAgent(profile: AgentProfile, grantId: string): Promise<string> {
    const now = Date.now();
    return this.ctx.storage.transactionSync(() => {
      let handle = profile.handle;
      for (let n = 2; this.sql.exec("SELECT 1 FROM agents WHERE handle = ?", handle).toArray().length > 0; n++) {
        const suffix = `-${n}`;
        handle = profile.handle.slice(0, LIMITS.handleLength - suffix.length) + suffix;
      }
      this.sql.exec(
        `INSERT INTO agents (id, handle, name, description, owner_sub, owner_email, created_at, last_active_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        profile.id,
        handle,
        profile.name,
        profile.description,
        profile.ownerSub,
        profile.ownerEmail,
        now,
        now,
      );
      this.audit(grantId, null, "register_agent");
      return handle;
    });
  }

  private audit(grantId: string, agentId: string | null, tool: string, conversationId: number | null = null): void {
    this.sql.exec(
      "INSERT INTO audit (at, grant_id, agent_id, tool, conversation_id) VALUES (?, ?, ?, ?, ?)",
      Date.now(),
      grantId,
      agentId,
      tool,
      conversationId,
    );
  }
}
