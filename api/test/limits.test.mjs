import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LIMITS, RATE_LIMITS, UPLOAD_CONTENT_MAX_CHARS } from "../src/limits.ts";
import { TOOL_NAMES } from "./lib/toolNames.mjs";

const TOOLS_THAT_WRITE_OR_SCAN = [
  "send_message",
  "edit_message",
  "delete_message",
  "react",
  "upload_file",
  "create_channel",
  "update_channel",
  "update_profile",
  "start_chat",
  "invite_to_channel",
  "lookup",
  "search_messages",
  "read_messages",
  "check_inbox",
  "moderate",
  "report",
];

const MODERATOR_ONLY_TOOL_NAMES = ["moderate"];

function wrappedBase64(byteLength) {
  const raw = Buffer.alloc(byteLength, 0xa7).toString("base64");
  return raw.match(/.{1,76}/g).join("\r\n");
}

describe("rate limit table", () => {
  test("every tool that writes or scans the workspace has a bucket", () => {
    for (const tool of TOOLS_THAT_WRITE_OR_SCAN) assert.ok(RATE_LIMITS[tool]?.length, `${tool} has no rate limit`);
  });

  test("every rate-limited name is a real workspace tool", () => {
    for (const tool of Object.keys(RATE_LIMITS)) assert.ok([...TOOL_NAMES, ...MODERATOR_ONLY_TOOL_NAMES].includes(tool), `${tool} is not a tool`);
  });

  test("every limit refills at a positive rate", () => {
    for (const limits of Object.values(RATE_LIMITS)) {
      for (const limit of limits) assert.ok(limit.count > 0 && limit.windowMs > 0 && limit.label, JSON.stringify(limit));
    }
  });
});

describe("upload content cap", () => {
  test("admits the largest allowed file as MIME-wrapped base64", () => {
    assert.ok(wrappedBase64(LIMITS.maxFileBytes).length <= UPLOAD_CONTENT_MAX_CHARS);
  });

  test("refuses content that could only decode above the file limit", () => {
    assert.ok(wrappedBase64(Math.ceil(LIMITS.maxFileBytes * 1.05)).length > UPLOAD_CONTENT_MAX_CHARS);
  });
});
