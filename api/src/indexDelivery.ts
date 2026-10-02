import { QUEUE_BATCH_MAX_MESSAGES } from "./limits";
import type { IndexJob, PendingIndexJob } from "./search/indexing";
import { all, one, run } from "./store";

const RETRY_MS = 30_000;
const DRAIN_MAX_ROWS = 300;
const DRAIN_MAX_MS = 1_000;

interface StoredJob {
  id: number;
  job: string;
  deliver_after: number;
}

export class IndexDelivery {
  private activeDrain: Promise<void> | undefined;
  private storage: DurableObjectStorage;
  private queue: Queue<IndexJob>;
  private now: () => number;
  private otherWorkAt: () => number | null;

  constructor(storage: DurableObjectStorage, queue: Queue<IndexJob>, now = Date.now, otherWorkAt: () => number | null = () => null) {
    this.storage = storage;
    this.queue = queue;
    this.otherWorkAt = otherWorkAt;
    this.now = now;
  }

  async storeJobs(workspaceId: string, jobs: PendingIndexJob[], createdAt: number): Promise<void> {
    if (!jobs.length) return;
    for (const { delaySeconds = 0, ...job } of jobs) {
      run(this.storage.sql, "INSERT INTO pending_index_jobs (job, deliver_after) VALUES (?, ?)",
        JSON.stringify({ ...job, ws: workspaceId }), createdAt + delaySeconds * 1_000);
    }
    await this.scheduleRetry(createdAt);
  }

  drain(): Promise<void> {
    this.activeDrain ??= this.drainBatches().finally(() => { this.activeDrain = undefined; });
    return this.activeDrain;
  }

  private async scheduleRetry(now: number): Promise<void> {
    const retryAt = now + RETRY_MS;
    const currentAlarm = await this.storage.getAlarm();
    if (currentAlarm === null || currentAlarm > retryAt) await this.storage.setAlarm(retryAt);
  }

  private async sendBeforeDeadline(batch: StoredJob[], deadline: number): Promise<void> {
    const now = this.now();
    const messages = batch.map((row) => ({
      body: JSON.parse(row.job) as IndexJob,
      delaySeconds: Math.max(0, Math.ceil((row.deliver_after - now) / 1_000)),
    }));
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        this.queue.sendBatch(messages),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("index queue send timed out")), Math.max(1, deadline - now));
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async drainBatches(): Promise<void> {
    const deadline = this.now() + DRAIN_MAX_MS;
    let delivered = 0;
    try {
      while (delivered < DRAIN_MAX_ROWS && this.now() < deadline) {
        const batch = all<StoredJob>(this.storage.sql,
          "SELECT id, job, deliver_after FROM pending_index_jobs ORDER BY id LIMIT ?",
          Math.min(QUEUE_BATCH_MAX_MESSAGES, DRAIN_MAX_ROWS - delivered));
        if (!batch.length) break;
        try {
          await this.sendBeforeDeadline(batch, deadline);
        } catch (error) {
          console.error(`${batch.length} index jobs remain pending for retry`, error);
          break;
        }
        run(this.storage.sql, "DELETE FROM pending_index_jobs WHERE id IN (SELECT value FROM json_each(?))",
          JSON.stringify(batch.map((row) => row.id)));
        delivered += batch.length;
      }
    } finally {
      await this.storage.transaction(async () => {
        if (one(this.storage.sql, "SELECT 1 FROM pending_index_jobs LIMIT 1")) await this.scheduleRetry(this.now());
        else {
          const otherWorkAt = this.otherWorkAt();
          if (otherWorkAt === null) await this.storage.deleteAlarm();
          else await this.storage.setAlarm(otherWorkAt);
        }
      });
    }
  }
}
