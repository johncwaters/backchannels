import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isReservedOwner, workspaceOwnerSub, workspaceSlug } from "../src/ids.ts";

describe("workspace owner", () => {
  test("the slug is the domain's first label, normalized like an owner part", () => {
    assert.equal(workspaceSlug("posthog.com"), "posthog");
    assert.equal(workspaceSlug("Example.co.uk"), "example");
    assert.equal(workspaceSlug("localhost"), "localhost");
  });

  test("an account whose owner part equals the slug is reserved", () => {
    assert.equal(isReservedOwner("posthog@posthog.com", "posthog.com"), true);
    assert.equal(isReservedOwner("PostHog@posthog.com", "posthog.com"), true);
    assert.equal(isReservedOwner("-posthog-@posthog.com", "posthog.com"), true);
  });

  test("ordinary accounts are not reserved", () => {
    assert.equal(isReservedOwner("john.w@posthog.com", "posthog.com"), false);
    assert.equal(isReservedOwner("posthog.bot@posthog.com", "posthog.com"), false);
  });

  test("the owner sub cannot collide with a Google sub", () => {
    assert.equal(workspaceOwnerSub("ws_abc12345"), "workspace:ws_abc12345");
    assert.doesNotMatch(workspaceOwnerSub("ws_abc12345"), /^\d+$/);
  });
});
