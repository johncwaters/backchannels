import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createDatabase, addAgentRow, scopeFor } from "./lib/sqlite.mjs";
import { createChannel } from "../src/conversations.ts";

function workspace(testContext) {
  const { database, sql } = createDatabase();
  testContext.after(() => database.close());
  const caller = addAgentRow(sql, { id: "caller", handle: "ian.m/caller" });
  addAgentRow(sql, { id: "other", handle: "other.m/other" });
  return { database, sql, scope: scopeFor(sql, caller), otherScope: scopeFor(sql, sql.exec("SELECT * FROM agents WHERE id = 'other'").toArray()[0]) };
}

describe("create_channel similar channel hints", () => {
  test("a close name still creates and joins with an additive hint", testContext => {
    const { database, scope } = workspace(testContext);
    createChannel(scope, { name: "github-actions", purpose: "Scheduled workflow failures" });
    const created = createChannel(scope, { name: "github-action", purpose: "CI runner access" });
    assert.equal(created.channel, "#github-action");
    assert.equal(created.joined, true);
    assert.deepEqual(created.similar.map(channel => channel.channel), ["#github-actions"]);
    assert.equal(created.similar[0].joined, true);
    assert.equal(created.similar[0].purpose, "Scheduled workflow failures");
    assert.match(created.note, /Created and joined/);
    assert.equal(database.prepare("SELECT count(*) AS n FROM conversations").get().n, 2);
  });

  test("shared purpose words suggest a channel with a different name", testContext => {
    const { scope, otherScope } = workspace(testContext);
    createChannel(otherScope, { name: "github-actions", purpose: "GitHub workflows, runners and secrets" });
    const created = createChannel(scope, { name: "build-lab", purpose: "Runners and secrets for GitHub workflows" });
    assert.deepEqual(created.similar.map(channel => channel.channel), ["#github-actions"]);
    assert.equal(created.similar[0].joined, false);
    assert.equal(created.similar[0].score, 1);
  });

  test("common words and a single purpose word do not produce hints", testContext => {
    const { scope } = workspace(testContext);
    createChannel(scope, { name: "database", purpose: "PostHog agents share channel posts about storage" });
    const created = createChannel(scope, { name: "build-lab", purpose: "PostHog agents share channel posts about runners" });
    assert.equal(created.similar, undefined);
    createChannel(scope, { name: "secrets-audit", purpose: "Runners, security, permissions and access" });
    const separate = createChannel(scope, { name: "deployment", purpose: "Runners, deployments, releases and rollbacks" });
    assert.equal(separate.similar, undefined);
  });

  test("hints exclude archived channels and private channels without membership", testContext => {
    const { sql, scope, otherScope } = workspace(testContext);
    createChannel(otherScope, { name: "github-actions", purpose: "GitHub workflows and runners", private: true });
    createChannel(otherScope, { name: "github-old", purpose: "GitHub workflows and runners" });
    sql.exec("UPDATE conversations SET archived_at = 1 WHERE slug = 'github-old'");
    const created = createChannel(scope, { name: "github-lab", purpose: "GitHub workflows and runners" });
    assert.equal(created.similar, undefined);
    sql.exec("INSERT INTO members (conversation_id, agent_id, joined_at) SELECT id, 'caller', 1 FROM conversations WHERE slug = 'github-actions'");
    const memberCreated = createChannel(scope, { name: "ci-lab", purpose: "GitHub workflows and runners" });
    assert.ok(memberCreated.similar.some(channel => channel.channel === "#github-actions"));
    assert.ok(memberCreated.similar.every(channel => channel.channel !== "#github-old"));
  });

  test("hints are bounded and ordered while exact duplicates still fail", testContext => {
    const { scope } = workspace(testContext);
    for (const name of ["delta", "bravo", "charlie", "alpha"]) createChannel(scope, { name, purpose: "GitHub workflows and runners" });
    const created = createChannel(scope, { name: "ci-lab", purpose: "GitHub workflows and runners" });
    assert.deepEqual(created.similar.map(channel => channel.channel), ["#alpha", "#bravo", "#charlie"]);
    assert.throws(() => createChannel(scope, { name: "ci-lab", purpose: "Different topic" }), /already exists/);
  });
});
