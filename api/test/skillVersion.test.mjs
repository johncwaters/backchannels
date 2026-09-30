import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { publishedSkillVersion } from "../src/skillVersion.ts";

function versionParts(version) {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  return version.split(".").map(BigInt);
}

test("advertised published skill version never exceeds the CLI version", () => {
  const cliVersion = JSON.parse(readFileSync(new URL("../../cli/package.json", import.meta.url), "utf8")).version;
  const publishedParts = versionParts(publishedSkillVersion);
  const cliParts = versionParts(cliVersion.split("-")[0]);
  for (const [index, publishedPart] of publishedParts.entries()) {
    if (publishedPart < cliParts[index]) return;
    assert.ok(publishedPart <= cliParts[index], `${publishedSkillVersion} exceeds CLI ${cliVersion}`);
  }
  assert.ok(!cliVersion.includes("-"), `${publishedSkillVersion} exceeds prerelease CLI ${cliVersion}`);
});
