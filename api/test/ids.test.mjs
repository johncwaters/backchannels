import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isReservedOwner, findOwnerNameWord, ownerNameRefusal, workspaceOwnerSub, workspaceSlug } from "../src/ids.ts";

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

describe("agent names never use the carbon unit's name", () => {
  test("a name containing a word of the email or display name is refused", () => {
    assert.ok(findOwnerNameWord("john", "john.w@posthog.com", "John Waters"));
    assert.ok(findOwnerNameWord("john-agent", "john.w@posthog.com", "John Waters"));
    assert.ok(findOwnerNameWord("waters_bot", "john.w@posthog.com", "John Waters"));
    assert.ok(findOwnerNameWord("johnw", "john.w@posthog.com", "John Waters"));
    assert.ok(findOwnerNameWord("johnwaters", "john.w@posthog.com", "John Waters"));
  });

  test("the matched owner word is returned", () => {
    assert.equal(findOwnerNameWord("john-agent", "john.w@posthog.com", "John Waters"), "john");
    assert.equal(findOwnerNameWord("waters_bot", "john.w@posthog.com", "John Waters"), "waters");
  });

  test("a plus tag in the email is not part of the carbon unit's name", () => {
    assert.equal(findOwnerNameWord("backchannel-helper", "john+backchannel@x.com", "John Waters"), undefined);
    assert.equal(findOwnerNameWord("john-helper", "john+backchannel@x.com", "John Waters"), "john");
  });

  test("names about the task pass, and short fragments do not count", () => {
    assert.equal(findOwnerNameWord("installer-builder", "john.w@posthog.com", "John Waters"), undefined);
    assert.equal(findOwnerNameWord("w-agent", "john.w@posthog.com", "John Waters"), undefined);
    assert.equal(findOwnerNameWord("johnson-deploy", "john.w@posthog.com", "John Waters"), undefined);
  });

  test("accented display names match their unaccented spelling", () => {
    assert.equal(findOwnerNameWord("muller-bot", "zm@posthog.com", "Zoë Müller"), "muller");
    assert.equal(findOwnerNameWord("zoe-helper", "zm@posthog.com", "Zoë Müller"), "zoe");
    assert.equal(findOwnerNameWord("zoemuller", "zm@posthog.com", "Zoë Müller"), "zoemuller");
  });

  test("the shared refusal applies to member accounts and exempts workspace owners", () => {
    const member = { sub: "user_1", email: "john.w@posthog.com", name: "John Waters" };
    assert.match(ownerNameRefusal("john", member), /'john' is part of your carbon unit's name/);
    assert.equal(ownerNameRefusal("deploy-agent", member), undefined);
    assert.equal(ownerNameRefusal("john", { ...member, sub: workspaceOwnerSub("ws_abc") }), undefined);
  });
});
