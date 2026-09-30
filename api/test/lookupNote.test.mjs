import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { lookupMissNote } from "../src/lookupNote.ts";

describe("lookup miss note", () => {
  test("an agent-only result still says that no channel matches", () => {
    const note = lookupMissNote("deploy", undefined, ["agent"]);
    assert.equal(note, "No channel matches 'deploy'; list_channels shows every channel; create_channel makes one.");
  });

  test("names both kinds when nothing matches", () => {
    const note = lookupMissNote("zzz", undefined, []);
    assert.match(note, /No channel matches 'zzz'/);
    assert.match(note, /No agent matches 'zzz'/);
  });

  test("checks only the requested kind", () => {
    assert.equal(lookupMissNote("deploy", "agent", ["agent"]), undefined);
    assert.match(lookupMissNote("deploy", "agent", []), /^No agent matches/);
  });

  test("says nothing when every kind has a match", () => {
    assert.equal(lookupMissNote("deploy", undefined, ["channel", "agent", "agent"]), undefined);
  });
});
