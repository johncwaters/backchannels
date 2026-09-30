import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { uploadFile, uploadText } from "../src/files.ts";
import { LIMITS } from "../src/limits.ts";
import { findSecret } from "../src/secrets.ts";
import { addAgentRow as addAgent, createDatabase, scopeFor } from "./lib/sqlite.mjs";

const UPPER_ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const fakeAwsKey = () => ["AK", "IA", ...Array.from(randomBytes(16), (byte) => UPPER_ALPHANUMERIC[byte % UPPER_ALPHANUMERIC.length])].join("");
const base64 = (bytes) => Buffer.from(bytes).toString("base64");
const PNG_HEADER = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const LONG_ALNUM_RUN = /[A-Za-z0-9+/_=-]{32,}/;
const deterministicBytes = (length, seed) => Uint8Array.from({ length }, (_, i) => (i * 37 + seed) % 256);
const MIXED_ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const ZIP_LOCAL_HEADER = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]);
const MACHO_HEADER = Uint8Array.from([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00, 0x00, 0x01, 0x03, 0x00, 0x00, 0x80]);
const RANDOM_SUFFIX_PATH = "glimmervoid-worktrees/backchannel-hYtl1F/api/src/UT";
const OPTION_LETTERS = "ABCFGHILOPRSTUWXabcdefghiklmnopqrstuvwxy1";
const lossyText = (bytes) => new TextDecoder("utf-8").decode(bytes.map((byte) => (byte === 0 ? 0x20 : byte)));

const zipLike = (...embedded) =>
  Buffer.concat([ZIP_LOCAL_HEADER, deterministicBytes(300, 7), Buffer.from([RANDOM_SUFFIX_PATH, ...embedded].join("\n")), deterministicBytes(300, 91)]);
const executableLike = (...embedded) =>
  Buffer.concat([MACHO_HEADER, deterministicBytes(256, 3), Buffer.alloc(64), Buffer.from([OPTION_LETTERS, ...embedded].join("\0")), deterministicBytes(256, 173)]);

function nulSeparatedFragments(totalBytes) {
  let state = 12345;
  const nextInt = (bound) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state % bound;
  };
  const fragments = [];
  let length = 0;
  while (length < totalBytes) {
    const fragment = Array.from({ length: 8 + nextInt(13) }, () => MIXED_ALNUM[nextInt(MIXED_ALNUM.length)]).join("");
    fragments.push(Buffer.from(fragment), Buffer.alloc(1));
    length += fragment.length + 1;
  }
  return Buffer.concat(fragments);
}

function uploader() {
  const { sql } = createDatabase();
  const agent = addAgent(sql, { id: "ag_uploader", handle: "ian.m/uploader" });
  const stored = [];
  const scope = scopeFor(sql, agent, { FILES: { put: async (key, bytes) => stored.push({ key, size: bytes.length }) } });
  const storedRow = (fileId) => sql.exec("SELECT * FROM files WHERE id = ?", fileId).toArray()[0];
  return { upload: (args) => uploadFile(scope, args), stored, storedRow };
}

const SECRET_ERROR = /content contains what looks like a secret/;

describe("upload_file decides text from the bytes, not the mime", () => {
  test("a dotenv file labelled application/octet-stream is still scanned and refused", async () => {
    const { upload, stored } = uploader();
    const content = base64(Buffer.from(`AWS_ACCESS_KEY_ID=${fakeAwsKey()}\nAWS_REGION=eu-west-1\n`));
    await assert.rejects(upload({ name: ".env", content, encoding: "base64", mime: "application/octet-stream" }), SECRET_ERROR);
    assert.equal(stored.length, 0);
  });

  test("text that is not valid UTF-8 is scanned through a lossy decode", async () => {
    const { upload } = uploader();
    const latin1 = Buffer.concat([Buffer.from("caf"), Buffer.from([0xe9]), Buffer.from(` token=${fakeAwsKey()}\n`)]);
    await assert.rejects(upload({ name: "notes.txt", content: base64(latin1), encoding: "base64" }), SECRET_ERROR);
  });

  test("a text-like upload with a clean body is stored and inlined whatever its mime", async () => {
    const { upload, stored, storedRow } = uploader();
    const text = "PORT=8788\nLOG_LEVEL=debug\n";
    const result = await upload({ name: "app.conf", content: base64(Buffer.from(text)), encoding: "base64", mime: "application/octet-stream" });
    assert.equal(result.mime, "application/octet-stream");
    assert.equal(stored.length, 1);
    assert.equal(storedRow(result.file_id).inline_text, text);
  });

  test("a binary with zero-padded runs is scanned, stored and never inlined", async () => {
    const { upload, stored, storedRow } = uploader();
    const binary = Buffer.concat([PNG_HEADER, deterministicBytes(200, 11), Buffer.alloc(64), deterministicBytes(200, 131)]);
    assert.doesNotMatch(new TextDecoder("utf-8").decode(binary.map((byte) => (byte === 0 ? 0x20 : byte))), LONG_ALNUM_RUN);
    const result = await upload({ name: "shot.png", content: base64(binary), encoding: "base64" });
    assert.equal(result.mime, "image/png");
    assert.equal(stored.length, 1);
    assert.equal(storedRow(result.file_id).inline_text, null);
  });

  test("a binary of short alnum fragments separated by NULs is stored, not mistaken for a high-entropy string", async () => {
    const { upload, stored, storedRow } = uploader();
    const binary = nulSeparatedFragments(2048);
    assert.ok(binary.length > 2048);
    assert.match(new TextDecoder("utf-8").decode(binary.filter((byte) => byte !== 0)), LONG_ALNUM_RUN);
    const result = await upload({ name: "bundle.zip", content: base64(binary), encoding: "base64" });
    assert.equal(result.mime, "application/zip");
    assert.equal(stored.length, 1);
    assert.equal(storedRow(result.file_id).inline_text, null);
  });

  test("a zip whose stored path reads as random is stored, not refused as a high-entropy string", async () => {
    const { upload, stored, storedRow } = uploader();
    const binary = zipLike();
    assert.equal(findSecret(lossyText(binary)), "high-entropy string");
    const result = await upload({ name: "src.zip", content: base64(binary), encoding: "base64" });
    assert.equal(result.mime, "application/zip");
    assert.equal(stored.length, 1);
    assert.equal(storedRow(result.file_id).inline_text, null);
  });

  test("an executable whose option string reads as random is stored, not refused as a high-entropy string", async () => {
    const { upload, stored, storedRow } = uploader();
    const binary = executableLike();
    assert.equal(findSecret(lossyText(binary)), "high-entropy string");
    const result = await upload({ name: "ls", content: base64(binary), encoding: "base64" });
    assert.equal(result.mime, "application/octet-stream");
    assert.equal(stored.length, 1);
    assert.equal(storedRow(result.file_id).inline_text, null);
  });

  test("a zip with an embedded AWS key is refused", async () => {
    const { upload, stored } = uploader();
    await assert.rejects(upload({ name: "src.zip", content: base64(zipLike(`aws_access_key_id = ${fakeAwsKey()}`)), encoding: "base64" }), SECRET_ERROR);
    assert.equal(stored.length, 0);
  });

  test("an executable with an embedded AWS key is refused", async () => {
    const { upload, stored } = uploader();
    await assert.rejects(upload({ name: "ls", content: base64(executableLike(`AWS_ACCESS_KEY_ID=${fakeAwsKey()}`)), encoding: "base64" }), SECRET_ERROR);
    assert.equal(stored.length, 0);
  });

  test("valid UTF-8 text containing a high-entropy token is still refused", async () => {
    const { upload, stored } = uploader();
    await assert.rejects(upload({ name: "notes.txt", content: `ls accepts the flags ${OPTION_LETTERS}\n` }), /high-entropy string/);
    assert.equal(stored.length, 0);
  });

  test("valid UTF-8 text with a stray NUL and a high-entropy token is still refused", async () => {
    const { upload, stored } = uploader();
    await assert.rejects(upload({ name: "notes.txt", content: `flags\u0000${OPTION_LETTERS}\n` }), /high-entropy string/);
    assert.equal(stored.length, 0);
  });

  test("UTF-16LE text containing a high-entropy token is still refused", async () => {
    const { upload, stored } = uploader();
    const content = Buffer.from(`flags ${OPTION_LETTERS}\r\n`, "utf16le");
    await assert.rejects(upload({ name: "transcript.txt", content: base64(content), encoding: "base64" }), /high-entropy string/);
    assert.equal(stored.length, 0);
  });

  test("text with a stray embedded NUL is still scanned and refused", async () => {
    const { upload, stored } = uploader();
    await assert.rejects(upload({ name: "notes.txt", content: `\u0000AWS_ACCESS_KEY_ID=${fakeAwsKey()}\n` }), SECRET_ERROR);
    assert.equal(stored.length, 0);
  });

  test("UTF-8 text padded with trailing NULs is scanned and refused", async () => {
    const { upload, stored } = uploader();
    const lines = Buffer.from(`AWS_ACCESS_KEY_ID=${fakeAwsKey()}\n`.repeat(5));
    const content = Buffer.concat([lines, Buffer.alloc(400)]);
    await assert.rejects(upload({ name: "creds.bin", content: base64(content), encoding: "base64" }), SECRET_ERROR);
    assert.equal(stored.length, 0);
  });

  test("UTF-8 text with NUL padding below the UTF-16 lane threshold is scanned and refused", async () => {
    const { upload, stored } = uploader();
    const lines = Buffer.from(`AWS_ACCESS_KEY_ID=${fakeAwsKey()}\n`.repeat(5));
    const content = Buffer.concat([lines, Buffer.alloc(60)]);
    await assert.rejects(upload({ name: "creds.bin", content: base64(content), encoding: "base64" }), SECRET_ERROR);
    assert.equal(stored.length, 0);
  });

  test("UTF-16LE text with a BOM is scanned and refused", async () => {
    const { upload, stored } = uploader();
    const content = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`AWS_ACCESS_KEY_ID=${fakeAwsKey()}\r\n`, "utf16le")]);
    await assert.rejects(upload({ name: "transcript.txt", content: base64(content), encoding: "base64" }), SECRET_ERROR);
    assert.equal(stored.length, 0);
  });

  test("UTF-16LE text without a BOM is scanned and refused", async () => {
    const { upload, stored } = uploader();
    const content = Buffer.from(`$env:AWS_ACCESS_KEY_ID = "${fakeAwsKey()}"\r\n`, "utf16le");
    await assert.rejects(upload({ name: "transcript.txt", content: base64(content), encoding: "base64" }), SECRET_ERROR);
    assert.equal(stored.length, 0);
  });

  test("UTF-16BE text without a BOM is scanned and refused", async () => {
    const { upload, stored } = uploader();
    const content = Buffer.from(`AWS_ACCESS_KEY_ID=${fakeAwsKey()}\n`, "utf16le").swap16();
    await assert.rejects(upload({ name: ".env", content: base64(content), encoding: "base64" }), SECRET_ERROR);
    assert.equal(stored.length, 0);
  });

  test("BOM-less UTF-16LE text followed by a short NUL run is scanned and refused", async () => {
    const { upload, stored } = uploader();
    const content = Buffer.concat([Buffer.from(`aws_key=${fakeAwsKey()}\n`, "utf16le"), Buffer.alloc(16)]);
    assert.equal(uploadText(content).fullScanTexts.length, 1);
    await assert.rejects(upload({ name: "creds.bin", content: base64(content), encoding: "base64" }), SECRET_ERROR);
    assert.equal(stored.length, 0);
  });

  test("BOM-less UTF-16BE text padded with NULs is scanned and refused", async () => {
    const { upload, stored } = uploader();
    const content = Buffer.concat([Buffer.from(`aws_key=${fakeAwsKey()}\n`, "utf16le").swap16(), Buffer.alloc(64)]);
    assert.equal(uploadText(content).fullScanTexts.length, 1);
    await assert.rejects(upload({ name: "creds.bin", content: base64(content), encoding: "base64" }), SECRET_ERROR);
    assert.equal(stored.length, 0);
  });

  test("BOM-less mostly-CJK UTF-16LE text hiding a key is scanned and refused", async () => {
    const { upload, stored } = uploader();
    const content = Buffer.from(`${"日本語のテキスト".repeat(10)}鍵=${fakeAwsKey()}\n`, "utf16le");
    assert.equal(uploadText(content).isText, false);
    await assert.rejects(upload({ name: "memo.txt", content: base64(content), encoding: "base64" }), SECRET_ERROR);
    assert.equal(stored.length, 0);
  });

  test("text above the inline limit is scanned to its last byte and not inlined", async () => {
    const { upload, storedRow } = uploader();
    const padding = "2026-09-30T12:00:01Z INFO request served path=/mcp status=200\n".repeat(Math.ceil((LIMITS.inlineTextMaxBytes * 1.5) / 60));
    await assert.rejects(upload({ name: "big.log", content: `${padding}key=${fakeAwsKey()}\n` }), SECRET_ERROR);
    const result = await upload({ name: "big.log", content: padding });
    assert.equal(storedRow(result.file_id).inline_text, null);
    assert.equal(result.size, Buffer.byteLength(padding));
  });
});

describe("uploadText", () => {
  test("valid UTF-8 comes back as both the full-scan text and the inline text", () => {
    const result = uploadText(new TextEncoder().encode("héllo\n"));
    assert.deepEqual(result.fullScanTexts, ["héllo\n"]);
    assert.equal(result.validUtf8, "héllo\n");
    assert.equal(result.isText, true);
  });

  test("invalid UTF-8 without a NUL gets the named-pattern scan only and is never inlined", () => {
    const result = uploadText(Uint8Array.from([0x61, 0xff, 0x62]));
    assert.equal(result.validUtf8, null);
    assert.equal(result.isText, false);
    assert.deepEqual(result.fullScanTexts, []);
    assert.match(result.namedPatternTexts[0], /^a.b$/u);
  });

  test("a stray NUL becomes a space for the scan, keeps the content text, and is never inlined", () => {
    const result = uploadText(new TextEncoder().encode("key=value\u0000tail\n"));
    assert.equal(result.validUtf8, null);
    assert.equal(result.isText, true);
    assert.deepEqual(result.fullScanTexts, ["key=value tail\n"]);
  });

  test("UTF-16LE without a BOM is decoded for the full scan and counts as text", () => {
    const result = uploadText(Buffer.from("password=hunter2\n", "utf16le"));
    assert.equal(result.validUtf8, null);
    assert.equal(result.isText, true);
    assert.ok(result.fullScanTexts.includes("password=hunter2\n"));
  });

  test("bytes that are neither UTF-8 nor UTF-16 are binary", () => {
    assert.equal(uploadText(zipLike()).isText, false);
    assert.equal(uploadText(executableLike()).isText, false);
  });

  test("UTF-16BE with a BOM is decoded for the full scan without the BOM", () => {
    const bytes = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from("password=hunter2\n", "utf16le").swap16()]);
    assert.ok(uploadText(bytes).fullScanTexts.includes("password=hunter2\n"));
  });

  test("NUL-heavy content is still fully scanned with each NUL as a space and never inlined", () => {
    const result = uploadText(Buffer.concat([Buffer.from("header".repeat(4)), Buffer.alloc(9), Buffer.from("trailer")]));
    assert.deepEqual(result.fullScanTexts, [`${"header".repeat(4)}${" ".repeat(9)}trailer`]);
    assert.equal(result.validUtf8, null);
    assert.equal(result.isText, true);
  });

  test("trailing NUL padding on UTF-8 text is not taken for UTF-16", () => {
    const result = uploadText(Buffer.concat([Buffer.from("password=hunter2\n"), Buffer.alloc(400)]));
    assert.deepEqual(result.fullScanTexts, [`password=hunter2\n${" ".repeat(400)}`]);
    assert.equal(result.validUtf8, null);
    assert.equal(result.isText, true);
  });

  test("every upload gets both UTF-16 decodes for the named-pattern scan", () => {
    const utf8Bytes = Buffer.from("password=hunter2\n");
    const utf8 = uploadText(utf8Bytes);
    assert.deepEqual(utf8.namedPatternTexts, [new TextDecoder("utf-16le").decode(utf8Bytes), new TextDecoder("utf-16be").decode(utf8Bytes)]);
    const utf16le = uploadText(Buffer.from("password=hunter2\n", "utf16le"));
    assert.deepEqual(utf16le.fullScanTexts.slice(1), ["password=hunter2\n"]);
    assert.equal(utf16le.namedPatternTexts.length, 1);
    const binary = uploadText(zipLike());
    assert.equal(binary.fullScanTexts.length, 0);
    assert.equal(binary.namedPatternTexts.length, 3);
  });
});
