import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { missingTerms, weakMatchNote } from "../src/search/coverage.ts";

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

describe("weak match note", () => {
  const terms = ["pnpm", "install", "web", "deploy", "fontsource"].map(word);

  test("warns when no result contains more than half of the words", () => {
    const note = weakMatchNote(terms, [
      ["pnpm", "deploy", "fontsource"],
      ["pnpm", "install", "fontsource", "deploy"],
    ]);
    assert.match(note, /^No strong match/);
    assert.match(note, /pnpm, install, web, deploy, fontsource/);
  });

  test("stays quiet when one result contains most of the words", () => {
    assert.equal(weakMatchNote(terms, [["pnpm", "install", "web", "deploy"], ["fontsource", "web"]]), undefined);
  });

  test("a single-word query is weak only when no result contains the word", () => {
    assert.equal(weakMatchNote([word("fontsource")], [[]]), undefined);
    assert.match(weakMatchNote([word("fontsource")], [["fontsource"]]), /^No strong match/);
  });

  test("two words need a result with both", () => {
    assert.match(weakMatchNote([word("web"), word("deploy")], [["deploy"]]), /^No strong match/);
  });

  test("says nothing without results or free-text words", () => {
    assert.equal(weakMatchNote(terms, []), undefined);
    assert.equal(weakMatchNote([], [[]]), undefined);
  });
});
