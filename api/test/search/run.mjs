import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODERN, evalRequest, mcpClient } from "../lib/mcp.mjs";
import { AGENTS, PINS, PRIVATE_CHANNELS, PUBLIC_CHANNELS, PUBLIC_MEMBERS, QUERIES, REACTIONS, timeline } from "./corpus.mjs";

const ROUTINE_POST_COUNT = 220;
const TOP_K = 10;
const INDEX_WAIT_MS = 240_000;
const INDEX_POLL_MS = 5_000;
const RATE_LIMIT_PATTERN = /retry in (\d+)s/;
const keepVectors = process.argv.includes("--keep");
const space = process.env.EVAL_SPACE ?? `s${Date.now().toString(36)}`;
const resultsDir = join(dirname(fileURLToPath(import.meta.url)), "results");

const clients = new Map();
function clientFor(agentRef) {
  const [owner, name] = agentRef.split("/");
  if (!clients.has(owner)) clients.set(owner, mcpClient(owner, MODERN, space));
  const client = clients.get(owner);
  return {
    async call(tool, args) {
      for (;;) {
        const result = await client.call(tool, { agent: name, ...args });
        const wait = !result.ok && RATE_LIMIT_PATTERN.exec(result.error);
        if (!wait) return result;
        await new Promise((resolve) => setTimeout(resolve, (Number(wait[1]) + 1) * 1000));
      }
    },
    async register(description) {
      return client.call("register_agent", { name, description });
    },
  };
}

async function must(promise, label) {
  const result = await promise;
  if (!result.ok) throw new Error(`${label}: ${result.error}`);
  return result.output;
}

const joined = new Set();
async function ensureMember(agentRef, channel) {
  const key = `${agentRef}#${channel}`;
  if (joined.has(key)) return;
  await must(clientFor(agentRef).call("join_channel", { channel: `#${channel}` }), `join ${key}`);
  joined.add(key);
}

const labelByMessageId = new Map();
const messageIdByLabel = new Map();
const visibility = new Map();

async function seed() {
  for (const agent of AGENTS) await must(clientFor(`${agent.owner}/${agent.name}`).register(agent.description), `register ${agent.name}`);
  for (const [channel, purpose] of PUBLIC_CHANNELS) {
    const [creator, ...others] = PUBLIC_MEMBERS[channel];
    await must(clientFor(creator).call("create_channel", { name: channel, purpose }), `create #${channel}`);
    joined.add(`${creator}#${channel}`);
    for (const member of others) await ensureMember(member, channel);
  }
  for (const [channel, purpose, members] of PRIVATE_CHANNELS) {
    const [creator, ...others] = members;
    await must(clientFor(creator).call("create_channel", { name: channel, purpose, private: true }), `create #${channel}`);
    const handles = others.map((member) => `@${member}`);
    if (handles.length) await must(clientFor(creator).call("invite_to_channel", { channel: `#${channel}`, agents: handles }), `invite #${channel}`);
    for (const member of members) joined.add(`${member}#${channel}`);
  }

  const privateMembers = new Map(PRIVATE_CHANNELS.map(([channel, , members]) => [`#${channel}`, new Set(members)]));
  const posts = timeline(ROUTINE_POST_COUNT);
  for (const post of posts) {
    if (post.to.startsWith("#") && !privateMembers.has(post.to)) await ensureMember(post.agent, post.to.slice(1));
    const args = { to: post.to, text: post.text };
    if (post.reply_to) args.reply_to = messageIdByLabel.get(post.reply_to);
    const sent = await must(clientFor(post.agent).call("send_message", args), `post ${post.id}`);
    labelByMessageId.set(sent.message.id, post.id);
    messageIdByLabel.set(post.id, sent.message.id);
    if (post.to.startsWith("@")) visibility.set(post.id, new Set([post.agent, post.to.slice(1)]));
    else if (privateMembers.has(post.to)) visibility.set(post.id, privateMembers.get(post.to));
  }
  for (const [agent, label, emoji] of REACTIONS) {
    await must(clientFor(agent).call("react", { message: messageIdByLabel.get(label), emoji }), `react ${label}`);
  }
  for (const [agent, label] of PINS) {
    await must(clientFor(agent).call("pin", { message: messageIdByLabel.get(label) }), `pin ${label}`);
  }
  return posts.length;
}

async function waitForIndex() {
  const deadline = Date.now() + INDEX_WAIT_MS;
  let status;
  while (Date.now() < deadline) {
    status = await evalRequest(`/eval/index-status?space=${space}`);
    if (status.missing === 0) return status;
    await new Promise((resolve) => setTimeout(resolve, INDEX_POLL_MS));
  }
  throw new Error(`indexing incomplete after ${INDEX_WAIT_MS / 1000}s: ${JSON.stringify(status)}`);
}

function canSee(searcher, label) {
  const members = visibility.get(label);
  return !members || members.has(searcher);
}

function matchesEveryResult(condition, result) {
  if (condition.authorOwner) return result.author.startsWith(`@${condition.authorOwner}/`);
  if (condition.author) return result.author === condition.author;
  if (condition.conversation) return result.conversation === condition.conversation;
  return false;
}

async function evaluate(query) {
  const started = Date.now();
  const output = await must(
    clientFor(query.searcher).call("search_messages", { query: query.query, limit: TOP_K, ...(query.sort ? { sort: query.sort } : {}) }),
    `search ${query.query}`,
  );
  const latencyMs = Date.now() - started;
  const results = output.results;
  const labels = results.map((result) => labelByMessageId.get(result.id) ?? result.id);
  const leaks = labels.filter((label) => !canSee(query.searcher, label));
  const evaluation = { ...query, labels, leaks, latencyMs };
  if (query.everyResult) {
    const matching = results.filter((result) => matchesEveryResult(query.everyResult, result)).length;
    evaluation.precision = results.length ? matching / results.length : 0;
  }
  if (query.relevant?.length) {
    const firstRank = labels.findIndex((label) => query.relevant.includes(label));
    evaluation.recall = query.relevant.filter((label) => labels.includes(label)).length / query.relevant.length;
    evaluation.reciprocalRank = firstRank === -1 ? 0 : 1 / (firstRank + 1);
  }
  return evaluation;
}

const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
const format = (value) => (value === null ? "   -  " : value.toFixed(3).padStart(6));

function summarize(evaluations) {
  const categories = [...new Set(evaluations.map((evaluation) => evaluation.category))];
  const rows = [...categories, "all"].map((category) => {
    const group = category === "all" ? evaluations : evaluations.filter((evaluation) => evaluation.category === category);
    return {
      category,
      queries: group.length,
      recallAt10: mean(group.filter((e) => e.recall !== undefined).map((e) => e.recall)),
      mrr: mean(group.filter((e) => e.reciprocalRank !== undefined).map((e) => e.reciprocalRank)),
      precision: mean(group.filter((e) => e.precision !== undefined).map((e) => e.precision)),
      leaks: group.reduce((sum, e) => sum + e.leaks.length, 0),
      p50LatencyMs: [...group.map((e) => e.latencyMs)].sort((a, b) => a - b)[Math.floor(group.length / 2)],
    };
  });
  console.log("\ncategory   queries  recall@10   MRR    precision  leaks  p50 ms");
  for (const row of rows) {
    console.log(
      `${row.category.padEnd(10)} ${String(row.queries).padStart(7)}  ${format(row.recallAt10)}  ${format(row.mrr)}  ${format(row.precision)}  ${String(row.leaks).padStart(5)}  ${String(row.p50LatencyMs).padStart(6)}`,
    );
  }
  const misses = evaluations.filter((e) => e.reciprocalRank !== undefined && e.reciprocalRank < 1);
  if (misses.length) {
    console.log("\nqueries whose first relevant result is not ranked first:");
    for (const miss of misses) console.log(`  ${miss.reciprocalRank ? `rank ${Math.round(1 / miss.reciprocalRank)}` : "missed"}  ${miss.query}  -> ${miss.labels.slice(0, 5).join(", ")}`);
  }
  return rows;
}

async function main() {
  console.log(`eval space ${space}`);
  const postCount = await seed();
  console.log(`seeded ${postCount} posts; waiting for the semantic index`);
  const index = await waitForIndex();
  console.log(`index ready: ${index.present} vectors`);
  const evaluations = [];
  for (const query of QUERIES) evaluations.push(await evaluate(query));
  const summary = summarize(evaluations);
  mkdirSync(resultsDir, { recursive: true });
  const file = join(resultsDir, `${space}.json`);
  writeFileSync(file, `${JSON.stringify({ space, postCount, summary, evaluations }, null, 2)}\n`);
  console.log(`\nfull results: ${file}`);
  if (!keepVectors) console.log(`purged ${(await evalRequest(`/eval/purge-vectors?space=${space}`, "POST")).deleted} vectors`);
  const leaks = evaluations.reduce((sum, evaluation) => sum + evaluation.leaks.length, 0);
  if (leaks) {
    console.error(`FAIL: ${leaks} private results leaked to agents that cannot see them`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
