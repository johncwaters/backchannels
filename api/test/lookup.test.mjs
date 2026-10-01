import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { lookup } from "../src/agents.ts";
import { LIMITS } from "../src/limits.ts";
import { DEFAULT_CHANNELS } from "../src/defaultChannels.ts";
import { addAgentRow as addAgent, createDatabase, scopeFor } from "./lib/sqlite.mjs";

function workspaceWithAgents() {
  const { sql } = createDatabase();
  const caller = addAgent(sql, { id: "ag_caller", handle: "ian.m/caller", description: "Runs the lookup tests" });
  return { sql, scope: scopeFor(sql, caller) };
}

const ids = (result) => result.results.map((match) => match.id);

function addChannel(sql, agentId, name, purpose) {
  const channel = sql.exec("INSERT INTO conversations (kind, name, slug, purpose, created_by, created_at) VALUES ('public', ?, ?, ?, ?, 1) RETURNING *", name, name, purpose, agentId).toArray()[0];
  sql.exec("INSERT INTO members (conversation_id, agent_id, joined_at) VALUES (?, ?, 1)", channel.id, agentId);
  return channel;
}

describe("lookup removes weak channel matches", () => {
  for (const kind of ["channel", undefined]) {
    for (const query of ["github actions", "claude"]) {
      test(`${query} has no unrelated default channel matches with kind ${kind}`, () => {
        const { sql, scope } = workspaceWithAgents();
        for (const channel of DEFAULT_CHANNELS) addChannel(sql, scope.agent.id, channel.name, channel.purpose);
        const result = lookup(scope, { query, kind });
        assert.equal(result.results.filter((match) => match.kind === "channel").length, 0);
        assert.match(result.note, /No channel matches/);
        assert.match(result.note, /list_channels/);
      });
    }
  }

  test("partial names and misspellings still find relevant channels", () => {
    const { sql, scope } = workspaceWithAgents();
    for (const channel of DEFAULT_CHANNELS) addChannel(sql, scope.agent.id, channel.name, channel.purpose);
    addChannel(sql, scope.agent.id, "github-actions", "GitHub Actions workflows and CI runners");
    addChannel(sql, scope.agent.id, "claude-routines", "Claude cloud routines and scheduled agents");
    assert.deepEqual(ids(lookup(scope, { query: "github actions", kind: "channel" })), ["#github-actions"]);
    assert.deepEqual(ids(lookup(scope, { query: "claude", kind: "channel" })), ["#claude-routines"]);
    assert.deepEqual(ids(lookup(scope, { query: "introduc", kind: "channel" })), ["#introductions"]);
    assert.deepEqual(ids(lookup(scope, { query: "backchannles", kind: "channel" })), ["#backchannels-feedback"]);
  });
});

describe("lookup scores agent descriptions on a bounded prefix", () => {
  test("a word inside the first characters of the description matches", () => {
    const { sql, scope } = workspaceWithAgents();
    addAgent(sql, { id: "ag_early", handle: "ian.m/early", description: "Zebra crossing deploys, watched daily" });
    assert.deepEqual(ids(lookup(scope, { query: "zebra", kind: "agent" })), ["@ian.m/early"]);
  });

  test("a word past the scored prefix does not match", () => {
    const { sql, scope } = workspaceWithAgents();
    const filler = "Handles ordinary chores. ".repeat(Math.ceil(LIMITS.lookupDescriptionLength / 25));
    addAgent(sql, { id: "ag_late", handle: "ian.m/late", description: `${filler} zebra` });
    assert.deepEqual(ids(lookup(scope, { query: "zebra", kind: "agent" })), []);
  });

  test("the handle still matches whatever the description holds", () => {
    const { sql, scope } = workspaceWithAgents();
    addAgent(sql, { id: "ag_zebra", handle: "ian.m/zebra", description: "x".repeat(2_000) });
    assert.deepEqual(ids(lookup(scope, { query: "zebra", kind: "agent" })), ["@ian.m/zebra"]);
  });
});

describe("the shared sql helper returns rows from INSERT ... RETURNING", () => {
  test("an inserted agent comes back with its generated columns", () => {
    const { sql } = workspaceWithAgents();
    const agent = addAgent(sql, { id: "ag_returned", handle: "ian.m/returned" });
    assert.equal(agent.id, "ag_returned");
    assert.equal(agent.name, "returned");
    assert.equal(sql.exec("INSERT INTO search_log (agent_id, query, sort, results, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id", "ag_returned", "q", "recent", 0, 1).toArray().length, 1);
  });
});
