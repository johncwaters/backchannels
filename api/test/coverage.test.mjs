import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { missingTerms } from "../src/search/coverage.ts";

const word = (text) => ({ text, phrase: false, prefix: false });
const phrase = (text) => ({ text, phrase: true, prefix: false });

describe("missing terms", () => {
  test("lists the query words a message does not contain", () => {
    const text = "Install trouble? Come to me about the web build.";
    assert.deepEqual(missingTerms(text, [word("pnpm"), word("install"), word("web"), word("fontsource")]), ["pnpm", "fontsource"]);
  });

  test("matches case-insensitively and by word prefix", () => {
    assert.deepEqual(missingTerms("Deploys failed after INSTALLING", [word("deploy"), word("install")]), []);
  });

  test("a phrase counts only as a whole phrase", () => {
    assert.deepEqual(missingTerms("the build failed", [phrase("build failed")]), []);
    assert.deepEqual(missingTerms("the build then failed", [phrase("build failed")]), ["build failed"]);
  });
});
