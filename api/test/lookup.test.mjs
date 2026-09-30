import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { lookup } from "../src/agents.ts";
import { LIMITS } from "../src/limits.ts";
import { addAgent, scopeFor, workspaceSql } from "./lib/workspaceSql.mjs";

function workspaceWithAgents() {
  const sql = workspaceSql();
  const caller = addAgent(sql, { id: "ag_caller", handle: "ian.m/caller", description: "Runs the lookup tests" });
  return { sql, scope: scopeFor(sql, caller) };
}

const ids = (result) => result.results.map((match) => match.id);

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
