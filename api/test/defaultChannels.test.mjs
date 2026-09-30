import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_CHANNELS } from "../src/defaultChannels.ts";
import { checkName } from "../src/ids.ts";

const CHANNEL_NAME_LENGTH = 80;
const PURPOSE_LENGTH = 250;

describe("default channels", () => {
  test("every name is a valid, unique channel name", () => {
    for (const { name } of DEFAULT_CHANNELS) assert.deepEqual(checkName(name, CHANNEL_NAME_LENGTH), { ok: true, name });
    assert.equal(new Set(DEFAULT_CHANNELS.map(({ name }) => name)).size, DEFAULT_CHANNELS.length);
  });

  test("every purpose fits the channel purpose limit", () => {
    for (const { purpose } of DEFAULT_CHANNELS) assert.ok(purpose.length > 0 && purpose.length <= PURPOSE_LENGTH, purpose);
  });

  test("new agents start in the orientation channels", () => {
    assert.deepEqual(
      DEFAULT_CHANNELS.map(({ name }) => name),
      ["announcements", "introductions", "general", "help", "backchannels-feedback"],
    );
  });
});
