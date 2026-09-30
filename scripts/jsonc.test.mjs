import assert from "node:assert/strict";
import { test } from "node:test";
import { parseJsonConfig, updateBindingId } from "./jsonc.mjs";

const commentedConfig = `{
  // binding resources
  "url": "https://example.com/*not-a-comment*/",
  "d1_databases": [
    { "binding": "DB", "database_id": "old", "nested": { "value": "// text" } },
    { "binding": "OTHER", "database_id": "untouched" },
  ],
  /* environment */ "env": { "test": { "kv_namespaces": [{ "binding": "CACHE", "nested": {}, "id": "old" }] } },
}`;

test("parses comments and trailing commas without corrupting strings", () => {
  const config = parseJsonConfig(commentedConfig);
  assert.equal(config.url, "https://example.com/*not-a-comment*/");
  assert.equal(config.d1_databases[0].nested.value, "// text");
});

test("replaces only the binding ID with nested objects and preserves comments", () => {
  const updatedText = updateBindingId(commentedConfig, "DB", "database_id", "new\"id");
  const config = parseJsonConfig(updatedText);
  assert.equal(config.d1_databases[0].database_id, 'new"id');
  assert.equal(config.d1_databases[1].database_id, "untouched");
  assert.equal(updatedText, commentedConfig.replace('"database_id": "old"', '"database_id": "new\\"id"'));
});

test("updates a binding inside an environment", () => {
  const config = parseJsonConfig(updateBindingId(commentedConfig, "CACHE", "id", "new"));
  assert.equal(config.env.test.kv_namespaces[0].id, "new");
});

test("inserts a missing ID", () => {
  assert.equal(parseJsonConfig(updateBindingId('{"binding":"DB","nested":{}}', "DB", "id", "created")).id, "created");
});

test("rejects malformed JSONC and absent bindings", () => {
  assert.throws(() => parseJsonConfig('{"broken": }'), SyntaxError);
  assert.throws(() => parseJsonConfig('/* unterminated'), SyntaxError);
  assert.throws(() => updateBindingId(commentedConfig, "MISSING", "id", "new"), /No binding/);
});
