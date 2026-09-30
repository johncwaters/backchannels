import { ensureWorkspaceOwner } from "../src/directory";
import { hashHeadlessKey, newHeadlessKey } from "../src/headless";
import { createHeadlessKeyFor, listHeadlessKeysFor, revokeHeadlessAgentFor, revokeHeadlessKeyFor, rotateHeadlessKeyFor } from "../src/headlessAdmin";
import worker from "../src/index";
import { serveMcp } from "../src/mcp";
import type { TuningOverrides } from "../src/search/config";
import { vectorId } from "../src/search/indexing";
import { deleteVectors } from "../src/search/vectors";

export { AdminApi, AdminClientsDO, ReindexWorkflow, WorkspaceDO } from "../src/index";

const DEFAULT_SPACE = "suite";
const EVAL_DOMAIN = "eval.example";
const REINDEX_PAGE = 1000;
const VECTOR_LOOKUP_BATCH = 20;
const MCP_ROUTE = /^\/eval\/(?:([a-z0-9]{1,16})\/)?([a-z0-9][a-z0-9-]{0,39})\/mcp$/;
const SPACE_PARAM = /^[a-z0-9]{1,16}$/;

interface EvalSpace {
  workspaceId: string;
  domain: string;
}

function evalSpace(space: string): EvalSpace {
  return { workspaceId: `ws_e${space}`, domain: `${space}.${EVAL_DOMAIN}` };
}

function spaceFromQuery(url: URL): EvalSpace | null {
  const space = url.searchParams.get("space") ?? DEFAULT_SPACE;
  return SPACE_PARAM.test(space) ? evalSpace(space) : null;
}

async function ensureCarbonUnit(env: Env, space: EvalSpace, who: string): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO workspaces (id, domain, name, created_at) VALUES (?, ?, ?, ?)").bind(
      space.workspaceId,
      space.domain,
      space.domain,
      now,
    ),
    env.DB.prepare(
      "INSERT OR IGNORE INTO carbon_units (sub, workspace_id, email, name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(`${space.workspaceId}-${who}`, space.workspaceId, `${who}@${space.domain}`, `${who} (eval)`, now, now),
  ]);
}

interface HeadlessSeed {
  suggestedName?: string;
  sponsorVerifiedAgoMs?: number | null;
  isSponsorSuspended?: boolean;
  expiresInMs?: number;
  isRevoked?: boolean;
}

async function seedHeadlessKey(env: Env, space: EvalSpace, seed: HeadlessSeed): Promise<Response> {
  const keyId = `hk_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const sponsor = `sponsor-${keyId}`;
  await ensureCarbonUnit(env, space, sponsor);
  await ensureWorkspaceOwner(env.DB, space.workspaceId);
  const now = Date.now();
  const verifiedAgoMs = seed.sponsorVerifiedAgoMs === undefined ? 0 : seed.sponsorVerifiedAgoMs;
  const sponsorSub = `${space.workspaceId}-${sponsor}`;
  await env.DB.prepare("UPDATE carbon_units SET last_verified_at = ?, headless_suspended_at = ? WHERE sub = ?")
    .bind(verifiedAgoMs === null ? null : now - verifiedAgoMs, seed.isSponsorSuspended ? now : null, sponsorSub)
    .run();
  const key = newHeadlessKey();
  await env.DB.prepare(
    `INSERT INTO headless_keys (id, workspace_id, label, suggested_name, key_hash, key_hint, sponsor_sub, created_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      keyId,
      space.workspaceId,
      "eval key",
      seed.suggestedName ?? "hosted-eval",
      await hashHeadlessKey(key),
      key.slice(-4),
      sponsorSub,
      now,
      now + (seed.expiresInMs ?? 60 * 60 * 1000),
      seed.isRevoked ? now : null,
    )
    .run();
  return Response.json({ key, keyId });
}

const HEADLESS_ADMIN_OPERATIONS = {
  list: listHeadlessKeysFor,
  create: createHeadlessKeyFor,
  rotate: rotateHeadlessKeyFor,
  revokeKey: revokeHeadlessKeyFor,
  revokeAgent: revokeHeadlessAgentFor,
} as const;

async function runHeadlessAdmin(
  env: Env,
  space: EvalSpace,
  body: { op: keyof typeof HEADLESS_ADMIN_OPERATIONS; who: string; isAdmin: boolean; verifiedAgoMs?: number | null; input: never },
) {
  const operation = HEADLESS_ADMIN_OPERATIONS[body.op];
  if (!operation) return new Response("unknown op", { status: 400 });
  await ensureCarbonUnit(env, space, body.who);
  const sub = `${space.workspaceId}-${body.who}`;
  const verifiedAt = body.verifiedAgoMs === null ? null : Date.now() - (body.verifiedAgoMs ?? 0);
  await env.DB.prepare("UPDATE carbon_units SET is_admin = ?, last_verified_at = ? WHERE sub = ?").bind(body.isAdmin ? 1 : 0, verifiedAt, sub).run();
  const identity = { sub, workspaceId: space.workspaceId, grantId: `eval-${sub}` };
  return Response.json(await operation(env, identity, body.input));
}

async function runAdminRead(env: Env, space: EvalSpace, body: { who: string; input: Parameters<WorkspaceStub["adminRead"]>[1] }) {
  await ensureCarbonUnit(env, space, body.who);
  const sub = `${space.workspaceId}-${body.who}`;
  return Response.json(await workspace(env, space).adminRead({ sub, grantId: `eval-${sub}`, workspaceId: space.workspaceId }, body.input));
}

async function runAdminSearch(env: Env, space: EvalSpace, body: { who: string; input: Parameters<WorkspaceStub["adminSearch"]>[1] }) {
  await ensureCarbonUnit(env, space, body.who);
  const sub = `${space.workspaceId}-${body.who}`;
  return Response.json(await workspace(env, space).adminSearch({ sub, grantId: `eval-${sub}`, workspaceId: space.workspaceId }, body.input));
}

type WorkspaceStub = ReturnType<typeof workspace>;

function workspace(env: Env, space: EvalSpace) {
  return env.WORKSPACE.get(env.WORKSPACE.idFromName(space.workspaceId));
}

async function allVectorIds(env: Env, space: EvalSpace): Promise<string[]> {
  const ids: string[] = [];
  let afterMessageId = 0;
  for (;;) {
    const batch = await workspace(env, space).reindexBatch(afterMessageId, REINDEX_PAGE);
    for (const job of batch.jobs) if (job.op === "upsert") ids.push(vectorId(space.workspaceId, job.conv, job.seq, job.kind));
    if (batch.lastId === null) return ids;
    afterMessageId = batch.lastId;
  }
}

async function indexStatus(env: Env, space: EvalSpace): Promise<Response> {
  const expected = (await allVectorIds(env, space)).filter((id) => !id.endsWith(":t"));
  let present = 0;
  for (let start = 0; start < expected.length; start += VECTOR_LOOKUP_BATCH) {
    present += (await env.VECTORS.getByIds(expected.slice(start, start + VECTOR_LOOKUP_BATCH))).length;
  }
  return Response.json({ expected: expected.length, present, missing: expected.length - present });
}

async function purgeVectors(env: Env, space: EvalSpace): Promise<Response> {
  let afterMessageId = 0;
  let deleted = 0;
  for (;;) {
    const batch = await workspace(env, space).reindexBatch(afterMessageId, REINDEX_PAGE);
    const ids = batch.jobs.map((job) => vectorId(space.workspaceId, job.conv, job.seq, job.kind));
    await deleteVectors(env, ids);
    deleted += ids.length;
    if (batch.lastId === null) return Response.json({ deleted });
    afterMessageId = batch.lastId;
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const mcp = MCP_ROUTE.exec(url.pathname);
    if (mcp) {
      const space = evalSpace(mcp[1] ?? DEFAULT_SPACE);
      const who = mcp[2];
      await ensureCarbonUnit(env, space, who);
      const auth = {
        sub: `${space.workspaceId}-${who}`,
        email: `${who}@${space.domain}`,
        workspace_id: space.workspaceId,
        grant_id: `eval-${space.workspaceId}-${who}`,
      };
      return serveMcp(new Request(new URL("/mcp", request.url), request), env, ctx, auth);
    }
    if (url.pathname.startsWith("/eval/")) {
      const space = spaceFromQuery(url);
      if (!space) return new Response("space must be 1-16 lowercase letters or digits", { status: 400 });
      if (url.pathname === "/eval/index-status") return indexStatus(env, space);
      if (url.pathname === "/eval/reindex" && request.method === "POST") {
        const instance = await env.REINDEX.create({ params: { workspace: space.workspaceId } });
        return Response.json({ id: instance.id });
      }
      if (url.pathname === "/eval/purge-vectors" && request.method === "POST") return purgeVectors(env, space);
      if (url.pathname === "/eval/headless-admin" && request.method === "POST") {
        return runHeadlessAdmin(env, space, (await request.json()) as Parameters<typeof runHeadlessAdmin>[2]);
      }
      if (url.pathname === "/eval/admin-read" && request.method === "POST") {
        return runAdminRead(env, space, (await request.json()) as Parameters<typeof runAdminRead>[2]);
      }
      if (url.pathname === "/eval/admin-search" && request.method === "POST") {
        return runAdminSearch(env, space, (await request.json()) as Parameters<typeof runAdminSearch>[2]);
      }
      if (url.pathname === "/eval/seed-headless" && request.method === "POST") {
        return seedHeadlessKey(env, space, (await request.json()) as HeadlessSeed);
      }
      if (url.pathname === "/eval/tuning" && request.method === "POST") {
        const body = (await request.json()) as { tuning?: TuningOverrides | null; resetSignals?: boolean };
        await workspace(env, space).setSearchTuning(body.tuning ?? null, body.resetSignals ?? true);
        return Response.json({ ok: true });
      }
    }
    return worker.fetch(request, env, ctx);
  },
  queue: worker.queue,
} satisfies ExportedHandler<Env>;
