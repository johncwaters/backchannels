import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { uploadFile, uploadText } from "../src/files.ts";
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

const JPEG_HEADER = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF_HEADER = Buffer.from("GIF89a");
const WEBP_HEADER = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from("WEBPVP8 ")]);
const IMAGES_ONLY = /accepts only PNG, JPEG, GIF or WebP images/;
const image = (header, ...embedded) => Buffer.concat([header, deterministicBytes(200, 11), Buffer.alloc(64), ...embedded.map((text) => Buffer.from(text)), deterministicBytes(200, 131)]);

describe("upload_file accepts only images, decided from the bytes", () => {
  for (const [label, header, mime] of [["PNG", PNG_HEADER, "image/png"], ["JPEG", JPEG_HEADER, "image/jpeg"], ["GIF", GIF_HEADER, "image/gif"], ["WebP", WEBP_HEADER, "image/webp"]]) {
    test(`a clean ${label} is stored with its type read from the bytes and never inlined`, async () => {
      const { upload, stored, storedRow } = uploader();
      const result = await upload({ name: "shot.bin", content: base64(image(header)), mime: "text/plain" });
      assert.equal(result.mime, mime);
      assert.equal(stored.length, 1);
      assert.equal(storedRow(result.file_id).inline_text, null);
    });
  }

  for (const [label, name, bytes] of [
    ["plain text", "notes.txt", Buffer.from("PORT=8788\nLOG_LEVEL=debug\n")],
    ["text named like an image", "shot.png", Buffer.from("not really a picture\n")],
    ["a zip", "src.zip", zipLike()],
    ["an executable", "ls", executableLike()],
    ["a RIFF file that is not WebP", "clip.wav", Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt ")])],
  ]) {
    test(`${label} is refused and nothing is stored`, async () => {
      const { upload, stored } = uploader();
      await assert.rejects(upload({ name, content: base64(bytes), mime: "image/png" }), IMAGES_ONLY);
      assert.equal(stored.length, 0);
    });
  }

  test("utf8 content is refused as not an image", async () => {
    const { upload, stored } = uploader();
    await assert.rejects(upload({ name: "notes.txt", content: "plain text", encoding: "utf8" }), IMAGES_ONLY);
    assert.equal(stored.length, 0);
  });

  test("an image carrying an AWS key in its bytes is refused", async () => {
    const { upload, stored } = uploader();
    await assert.rejects(upload({ name: "shot.png", content: base64(image(PNG_HEADER, `AWS_ACCESS_KEY_ID=${fakeAwsKey()}`)) }), SECRET_ERROR);
    assert.equal(stored.length, 0);
  });

  test("an image carrying a UTF-16 key in its bytes is refused", async () => {
    const { upload, stored } = uploader();
    const utf16Key = Buffer.from(`AWS_ACCESS_KEY_ID=${fakeAwsKey()}`, "utf16le");
    await assert.rejects(upload({ name: "shot.png", content: base64(Buffer.concat([image(PNG_HEADER), utf16Key])) }), SECRET_ERROR);
    assert.equal(stored.length, 0);
  });

  test("an image whose bytes read as a random string is stored, not refused as a high-entropy string", async () => {
    const { upload, stored } = uploader();
    const result = await upload({ name: "shot.png", content: base64(image(PNG_HEADER, RANDOM_SUFFIX_PATH)) });
    assert.equal(result.mime, "image/png");
    assert.equal(stored.length, 1);
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
