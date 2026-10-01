import assert from "node:assert/strict";
import { test } from "node:test";
import { createDatabase } from "./lib/sqlite.mjs";
import { IndexDelivery } from "../src/indexDelivery.ts";

function fixture(context) {
  const { database, sql } = createDatabase();
  context.after(() => database.close());
  context.mock.method(console, "error", () => {});
  let alarm = null;
  let now = 10_000_000;
  const storage = {
    sql,
    getAlarm: async () => alarm,
    setAlarm: async (time) => { alarm = time; },
    deleteAlarm: async () => { alarm = null; },
    async transaction(callback) {
      const priorAlarm = alarm;
      database.exec("BEGIN");
      try {
        const result = await callback();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        alarm = priorAlarm;
        throw error;
      }
    },
  };
  const jobs = (count, { offset = 0, delaySeconds = 0 } = {}) => Array.from({ length: count }, (_, index) => ({
    op: "upsert", conv: 1, seq: offset + index + 1, kind: "msg", version: 1, delaySeconds,
  }));
  const pending = () => database.prepare("SELECT id, job, deliver_after FROM pending_index_jobs ORDER BY id").all();
  const delivery = (queue) => new IndexDelivery(storage, queue, () => now);
  const store = (sender, entries) => storage.transaction(() => sender.storeJobs("ws_test", entries, now));
  return { storage, database, pending, jobs, delivery, store, advance: (ms) => { now += ms; } };
}

test("a failed queue send keeps every job and a new delivery instance retries it", async (context) => {
  const f = fixture(context);
  const sender = f.delivery({ sendBatch: async () => { throw new Error("queue unavailable"); } });
  await f.store(sender, f.jobs(2));
  const before = f.pending();
  await sender.drain();
  assert.deepEqual(f.pending(), before);
  assert.equal(await f.storage.getAlarm(), 10_030_000);
  const sent = [];
  await f.delivery({ sendBatch: async (batch) => { sent.push(...batch); } }).drain();
  assert.deepEqual(sent.map(({ body }) => body.seq), [1, 2]);
  assert.ok(sent.every(({ body }) => body.ws === "ws_test"));
  assert.deepEqual(f.pending(), []);
  assert.equal(await f.storage.getAlarm(), null);
});

test("a partial drain deletes only successful batches and caps each drain at 300 rows", async (context) => {
  const f = fixture(context);
  let calls = 0;
  const sender = f.delivery({ sendBatch: async () => { if (++calls === 2) throw new Error("second batch failed"); } });
  await f.store(sender, f.jobs(450));
  await sender.drain();
  assert.equal(f.pending().length, 350);
  assert.equal(JSON.parse(f.pending()[0].job).seq, 101);
  const batches = [];
  const retry = f.delivery({ sendBatch: async (batch) => { batches.push(batch); } });
  await retry.drain();
  assert.deepEqual(batches.map((batch) => batch.length), [100, 100, 100]);
  assert.equal(f.pending().length, 50);
  assert.equal(JSON.parse(f.pending()[0].job).seq, 401);
  assert.equal(await f.storage.getAlarm(), 10_030_000);
  await retry.drain();
  assert.deepEqual(f.pending(), []);
});

test("queue acceptance followed by a failed deletion repeats the same job", async (context) => {
  const f = fixture(context);
  const sent = [];
  const sender = f.delivery({ sendBatch: async (batch) => { sent.push(...batch); } });
  await f.store(sender, f.jobs(1));
  const exec = f.storage.sql.exec;
  f.storage.sql.exec = (query, ...bindings) => {
    if (query.startsWith("DELETE FROM pending_index_jobs")) throw new Error("storage interrupted");
    return exec(query, ...bindings);
  };
  await assert.rejects(sender.drain(), /storage interrupted/);
  assert.equal(f.pending().length, 1);
  assert.equal(await f.storage.getAlarm(), 10_030_000);
  f.storage.sql.exec = exec;
  await f.delivery({ sendBatch: async (batch) => { sent.push(...batch); } }).drain();
  assert.deepEqual(sent[1], sent[0]);
  assert.deepEqual(f.pending(), []);
});

test("concurrent drains share one send and jobs added during the send remain queued", async (context) => {
  const f = fixture(context);
  let release;
  let calls = 0;
  const sender = f.delivery({ sendBatch: async () => {
    calls++;
    await new Promise((resolve) => { release = resolve; });
  } });
  await f.store(sender, f.jobs(1));
  const first = sender.drain();
  const second = sender.drain();
  assert.equal(first, second);
  await f.store(sender, f.jobs(1, { offset: 1 }));
  f.advance(1_000);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(f.pending().map(({ job }) => JSON.parse(job).seq), [2]);
  assert.equal(await f.storage.getAlarm(), 10_030_000);
});

test("retry preserves the remaining thread delay and never postpones an earlier alarm", async (context) => {
  const f = fixture(context);
  const sent = [];
  const sender = f.delivery({ sendBatch: async (batch) => { sent.push(...batch); } });
  await f.storage.setAlarm(10_001_000);
  await f.store(sender, f.jobs(1, { delaySeconds: 60 }));
  assert.equal(await f.storage.getAlarm(), 10_001_000);
  f.advance(30_001);
  await sender.drain();
  assert.equal(sent[0].delaySeconds, 30);
  assert.equal("delaySeconds" in sent[0].body, false);
  await f.store(sender, f.jobs(1, { delaySeconds: 60 }));
  f.advance(90_000);
  await sender.drain();
  assert.equal(sent[1].delaySeconds, 0);
});

test("a stalled queue send returns within the time budget and leaves its job for retry", async (context) => {
  const f = fixture(context);
  const sender = f.delivery({ sendBatch: () => new Promise(() => {}) });
  await f.store(sender, f.jobs(1));
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const drain = sender.drain();
  context.mock.timers.tick(1_000);
  await drain;
  assert.equal(f.pending().length, 1);
  assert.equal(await f.storage.getAlarm(), 10_030_000);
});
