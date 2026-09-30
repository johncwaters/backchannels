import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHarness } from "./harness.js";
import { backupOnce, fileUpdateAction, readTomlTableUrl, setJsonEntry, setTomlTable, writeAtomic } from "../config-file.js";

const url = "https://api.backchannels.dev/mcp";

test("TOML edits preserve surrounding tables and comments byte for byte", () => {
  const before = '# keep before\n[mcp_servers.foreign]\nurl = "https://foreign.test"\n\n';
  const after = '# keep after\n[preferences]\ntheme = "dark"\n';
  const table = '[mcp_servers.backchannels]\nurl = "https://old.test"\n';
  const source = before + table + after;
  const updated = setTomlTable(source, url);
  assert.equal(updated, before + `[mcp_servers.backchannels]\nurl = "${url}"\n` + after);
  assert.equal(readTomlTableUrl(updated), url);
  assert.equal(setTomlTable(updated, url), updated);
});

test("empty TOML and a final table round trip", () => {
  const updated = setTomlTable("", url);
  assert.equal(updated, `[mcp_servers.backchannels]\nurl = "${url}"\n`);
  assert.equal(readTomlTableUrl('[mcp_servers."backchannels"]\nurl = \'https://example.test\' # a fact\n'), "https://example.test");
});

test("JSON edits keep foreign entries and reject malformed structures", () => {
  const source = '{"mcpServers":{"foreign":{"url":"https://foreign.test"}},"theme":"dark"}\n';
  const updated = setJsonEntry(source, url);
  assert.deepEqual(JSON.parse(updated).mcpServers.foreign, { url: "https://foreign.test" });
  assert.equal(setJsonEntry(updated, url), updated);
  assert.throws(() => setJsonEntry('{"mcpServers":[]}', url));
  assert.throws(() => setJsonEntry("invalid", url));
});

test("atomic writes follow links, preserve modes and back up once with private permissions", async () => {
  const harness = await createHarness([]);
  try {
    const original = join(harness.home, "managed.json");
    await writeFile(original, '{"mcpServers":{}}\n');
    await chmod(original, 0o640);
    await mkdir(join(harness.home, ".cursor"));
    await symlink(original, harness.cursorConfig);
    await backupOnce(harness.cursorConfig);
    await writeAtomic(harness.cursorConfig, setJsonEntry(await readFile(original, "utf8"), url));
    assert.equal((await stat(original)).mode & 0o777, 0o640);
    assert.equal((await stat(`${original}.backchannels.bak`)).mode & 0o777, 0o600);
    await backupOnce(harness.cursorConfig);
    assert.equal(await readFile(`${original}.backchannels.bak`, "utf8"), '{"mcpServers":{}}\n');
    assert.equal(JSON.parse(await readFile(harness.cursorConfig, "utf8")).mcpServers.backchannels.url, url);
  } finally {
    await harness.close();
  }
});

test("comments inside a TOML table do not hide the URL or truncate its removal", () => {
  const source = '[mcp_servers.backchannels]\n# internal fact\nurl = "https://old.test"\n\n# retain for next table\n[next]\nenabled = true\n';
  assert.equal(readTomlTableUrl(source), "https://old.test");
  const updated = setTomlTable(source, url);
  assert.equal(readTomlTableUrl(updated), url);
  assert.equal(updated, `[mcp_servers.backchannels]\n# internal fact\nurl = "${url}"\n\n# retain for next table\n[next]\nenabled = true\n`);
});

test("table-shaped text inside multiline TOML strings is preserved", () => {
  const foreign = 'description = """\n[mcp_servers.backchannels]\nurl = "https://text.test"\n"""\n[mcp_servers.foreign]\nurl = "https://foreign.test"\n';
  const updated = setTomlTable(foreign, url);
  const appendedTable = `[mcp_servers.backchannels]\nurl = "${url}"\n`;
  assert.equal(updated, foreign + appendedTable);
  assert.equal(readTomlTableUrl(updated), url);
  const literal = foreign.replaceAll('"""', "'''");
  assert.equal(setTomlTable(literal, url), literal + appendedTable);
});

test("TOML edits change only the url line and keep every other key in the table", () => {
  const source = '[mcp_servers.backchannels]\nenabled_tools = ["search"]\n  url = "https://old.test" # pinned\nstartup_timeout_sec = 20\n[next]\n';
  assert.equal(setTomlTable(source, url), `[mcp_servers.backchannels]\nenabled_tools = ["search"]\n  url = "${url}"\nstartup_timeout_sec = 20\n[next]\n`);
  const withoutUrl = '[mcp_servers.backchannels]\nstartup_timeout_sec = 20\n';
  assert.equal(setTomlTable(withoutUrl, url), `[mcp_servers.backchannels]\nurl = "${url}"\nstartup_timeout_sec = 20\n`);
});

test("TOML inline and dotted backchannels definitions are refused rather than duplicated", () => {
  for (const source of [
    '[mcp_servers]\nbackchannels = { url = "https://old.test" }\n',
    '[mcp_servers]\nbackchannels.url = "https://old.test"\n',
    'mcp_servers.backchannels.url = "https://old.test"\n',
    'mcp_servers = { backchannels = { url = "https://old.test" } }\n',
  ]) {
    assert.throws(() => setTomlTable(source, url), /edit that entry by hand/);
  }
  const foreignInline = '[mcp_servers]\nforeign = { url = "https://foreign.test" }\n';
  assert.equal(setTomlTable(foreignInline, url), `${foreignInline}[mcp_servers.backchannels]\nurl = "${url}"\n`);
});

test("a root inline mcp_servers table is refused whatever servers it holds", () => {
  for (const source of ['mcp_servers = { other = { url = "https://other.test" } }\n', 'mcp_servers = {}\n', '"mcp_servers" = { }\n[next]\n']) {
    assert.throws(() => setTomlTable(source, url), /edit that entry by hand/);
  }
});

test("a multiline TOML url value is refused rather than partly rewritten", () => {
  for (const source of ['[mcp_servers.backchannels]\nurl = """\nhttps://old.test\n"""\n', "[mcp_servers.backchannels]\nurl = '''\nhttps://old.test\n'''\n", '[mcp_servers.backchannels]\nurl = """https://old.test"""\n']) {
    assert.throws(() => setTomlTable(source, url), /multiline string; edit that entry by hand/);
  }
});

test("TOML edits keep CRLF line endings on every written line", () => {
  const replaced = setTomlTable('[a]\r\nx = 1\r\n[mcp_servers.backchannels]\r\nurl = "https://old.test"\r\n', url);
  const inserted = setTomlTable('[a]\r\nx = 1\r\n[mcp_servers.backchannels]\r\nstartup_timeout_sec = 20\r\n', url);
  const insertedAtEnd = setTomlTable("[a]\r\nx = 1\r\n[mcp_servers.backchannels]", url);
  const appended = setTomlTable("[a]\r\nx = 1", url);
  for (const updated of [replaced, inserted, insertedAtEnd, appended]) {
    assert.equal(readTomlTableUrl(updated), url);
    assert.doesNotMatch(updated, /(?<!\r)\n/);
  }
});

test("JSON edits change only the url and keep other keys in the entry", () => {
  const source = '{"mcpServers":{"backchannels":{"url":"https://old.test","headers":{"X-Team":"core"},"enabled":true}}}';
  assert.deepEqual(JSON.parse(setJsonEntry(source, url)).mcpServers.backchannels, { url, headers: { "X-Team": "core" }, enabled: true });
});

test("file updates recompute from the file contents at apply time", async () => {
  const harness = await createHarness([]);
  try {
    const path = join(harness.home, "config.toml");
    const planned = '[mcp_servers.foreign]\nurl = "https://foreign.test"\n';
    const editedAfterPlanning = `${planned}[added.later]\nkeep = true\n`;
    await writeFile(path, planned);
    const [action] = await fileUpdateAction(path, source => setTomlTable(source, url), "set url");
    await writeFile(path, editedAfterPlanning);
    assert.equal(action?.kind, "file");
    if (action?.kind !== "file") return;
    await action.apply();
    assert.equal(await readFile(path, "utf8"), `${editedAfterPlanning}[mcp_servers.backchannels]\nurl = "${url}"\n`);
  } finally {
    await harness.close();
  }
});
