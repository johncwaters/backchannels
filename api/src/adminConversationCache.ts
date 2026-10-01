const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 256;

interface Entry<Row> {
  revision: string;
  expiresAt: number;
  row: Row;
}

export class AdminConversationCache<Row extends { slug: string }> {
  private entries = new Map<string, Entry<Row>>();

  get(ownerSub: string, slug: string, revision: string, now: number): Row | undefined {
    const key = JSON.stringify([ownerSub, slug]);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.revision !== revision || entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { ...entry.row };
  }

  set(ownerSub: string, revision: string, now: number, rows: Row[]): void {
    for (const row of rows) {
      const key = JSON.stringify([ownerSub, row.slug]);
      this.entries.delete(key);
      this.entries.set(key, { revision, expiresAt: now + CACHE_TTL_MS, row: { ...row } });
    }
    while (this.entries.size > CACHE_MAX_ENTRIES) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }
}
