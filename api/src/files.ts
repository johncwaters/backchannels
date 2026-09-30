import { fileId } from "./ids";
import { LIMITS } from "./limits";
import { scanFields } from "./secrets";
import { ToolError, all, one, run, type Scope } from "./store";

interface FileRow {
  id: string;
  uploader_id: string;
  message_id: number | null;
  name: string;
  mime: string;
  size: number;
  inline_text: string | null;
}

export interface FileView {
  id: string;
  name: string;
  mime: string;
  size: number;
  text?: string;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  ndjson: "application/x-ndjson",
  yaml: "application/yaml",
  yml: "application/yaml",
  xml: "application/xml",
  html: "text/html",
  diff: "text/x-diff",
  patch: "text/x-diff",
  ts: "text/plain",
  js: "text/plain",
  py: "text/plain",
  sql: "text/plain",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  zip: "application/zip",
};

function cleanFileName(input: string): string {
  const baseName = input.split(/[/\\]/).pop() ?? "";
  const name = baseName.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, LIMITS.fileNameLength);
  if (!name || name === "." || name === "..") throw new ToolError("name must be a file name such as 'error.log'");
  return name;
}

function guessMime(name: string, encoding: "utf8" | "base64"): string {
  const extension = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return MIME_BY_EXTENSION[extension] ?? (encoding === "utf8" ? "text/plain" : "application/octet-stream");
}

function decode(content: string, encoding: "utf8" | "base64"): Uint8Array {
  if (encoding === "utf8") return new TextEncoder().encode(content);
  try {
    return Uint8Array.from(atob(content.replace(/\s+/g, "")), (char) => char.charCodeAt(0));
  } catch {
    throw new ToolError("content is not valid base64; send text with encoding 'utf8'");
  }
}

interface UploadText {
  fullScanTexts: string[];
  namedPatternTexts: string[];
  validUtf8: string | null;
  isText: boolean;
}

const NUL_BYTE = 0;
const SPACE_BYTE = 0x20;
const UTF16_ENCODINGS = ["utf-16le", "utf-16be"] as const;
type Utf16Encoding = (typeof UTF16_ENCODINGS)[number];
const UTF16_NUL_LANE_MIN_RATIO = 0.4;
const UTF16_OTHER_LANE_NUL_MAX_RATIO = 0.1;

interface NulCounts {
  total: number;
  atEvenIndex: number;
  atOddIndex: number;
}

function countNuls(bytes: Uint8Array): NulCounts {
  let atEvenIndex = 0;
  let atOddIndex = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== NUL_BYTE) continue;
    if (i % 2 === 0) {
      atEvenIndex++;
      continue;
    }
    atOddIndex++;
  }
  return { total: atEvenIndex + atOddIndex, atEvenIndex, atOddIndex };
}

function utf16Encoding(bytes: Uint8Array, nuls: NulCounts): Utf16Encoding | null {
  if (bytes.length < 2) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  if (nuls.total === 0) return null;
  const oddLaneLength = Math.floor(bytes.length / 2);
  const evenLaneLength = Math.ceil(bytes.length / 2);
  const isOddLaneNul = nuls.atOddIndex >= oddLaneLength * UTF16_NUL_LANE_MIN_RATIO;
  if (isOddLaneNul && nuls.atEvenIndex < nuls.atOddIndex * UTF16_OTHER_LANE_NUL_MAX_RATIO) return "utf-16le";
  const isEvenLaneNul = nuls.atEvenIndex >= evenLaneLength * UTF16_NUL_LANE_MIN_RATIO;
  if (isEvenLaneNul && nuls.atOddIndex < nuls.atEvenIndex * UTF16_OTHER_LANE_NUL_MAX_RATIO) return "utf-16be";
  return null;
}

function nulsAsSpaces(bytes: Uint8Array, nuls: NulCounts): Uint8Array {
  if (nuls.total === 0) return bytes;
  return bytes.map((byte) => (byte === NUL_BYTE ? SPACE_BYTE : byte));
}

function strictUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

export function uploadText(bytes: Uint8Array): UploadText {
  const nuls = countNuls(bytes);
  const scannableBytes = nulsAsSpaces(bytes, nuls);
  const strictText = strictUtf8(scannableBytes);
  const utf8Text = strictText ?? new TextDecoder("utf-8").decode(scannableBytes);
  const detectedUtf16 = utf16Encoding(bytes, nuls);
  const isText = strictText !== null || detectedUtf16 !== null;
  const fullScanTexts: string[] = [];
  const namedPatternTexts: string[] = [];
  (isText ? fullScanTexts : namedPatternTexts).push(utf8Text);
  for (const encoding of UTF16_ENCODINGS) {
    (encoding === detectedUtf16 ? fullScanTexts : namedPatternTexts).push(new TextDecoder(encoding).decode(bytes));
  }
  const validUtf8 = nuls.total === 0 ? strictText : null;
  return { fullScanTexts, namedPatternTexts, validUtf8, isText };
}

export async function uploadFile(scope: Scope, args: { name: string; content: string; encoding?: "utf8" | "base64"; mime?: string }) {
  const encoding = args.encoding ?? "utf8";
  const name = cleanFileName(args.name);
  const mime = (args.mime?.trim().toLowerCase() || guessMime(name, encoding)).slice(0, 100);
  const bytes = decode(args.content, encoding);
  if (bytes.length === 0) throw new ToolError("content is empty");
  if (bytes.length > LIMITS.maxFileBytes) {
    throw new ToolError(`the file has ${bytes.length} bytes; the limit is ${LIMITS.maxFileBytes} (5 MB). Share a smaller excerpt`);
  }
  const text = uploadText(bytes);
  const secretFound = scanFields({ content: text.fullScanTexts }) ?? scanFields({ content: text.namedPatternTexts }, { heuristics: false });
  if (secretFound) throw new ToolError(secretFound);

  const id = fileId();
  const r2Key = `${scope.workspaceId}/${id}/${name}`;
  await scope.env.FILES.put(r2Key, bytes, { httpMetadata: { contentType: mime } });
  const fitsInline = bytes.length <= LIMITS.inlineTextMaxBytes;
  const inlineText = fitsInline ? text.validUtf8 : null;
  run(
    scope.sql,
    `INSERT INTO files (id, uploader_id, message_id, name, mime, size, r2_key, created_at, inline_text)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
    id,
    scope.agent.id,
    name,
    mime,
    bytes.length,
    r2Key,
    scope.now,
    inlineText,
  );
  return { file_id: id, name, mime, size: bytes.length, hint: "pass file_id in file_ids on send_message to share it" };
}

export function attachFiles(scope: Scope, messageId: number, fileIds: string[]): void {
  const ids = [...new Set(fileIds.map((id) => id.trim()))];
  if (ids.length > LIMITS.filesPerMessage) throw new ToolError(`a message holds at most ${LIMITS.filesPerMessage} files`);
  for (const id of ids) {
    const file = one<FileRow>(scope.sql, "SELECT * FROM files WHERE id = ?", id);
    if (!file || file.uploader_id !== scope.agent.id) throw new ToolError(`file ${id} not found; upload_file returns the file_id to send`);
    if (file.message_id !== null) throw new ToolError(`file ${id} is already attached to a message; upload it again to share it twice`);
    run(scope.sql, "UPDATE files SET message_id = ? WHERE id = ?", messageId, id);
  }
  if (ids.length) run(scope.sql, "UPDATE messages SET has_file = 1 WHERE id = ?", messageId);
}

export function filesOf(scope: Scope, messageId: number, includeText: boolean): FileView[] {
  return all<FileRow>(scope.sql, "SELECT * FROM files WHERE message_id = ? ORDER BY created_at, id", messageId).map((file) => ({
    id: file.id,
    name: file.name,
    mime: file.mime,
    size: file.size,
    ...(includeText && file.inline_text !== null ? { text: file.inline_text } : {}),
  }));
}

export function fileNamesOf(sql: SqlStorage, messageId: number): string[] {
  return all<{ name: string }>(sql, "SELECT name FROM files WHERE message_id = ? ORDER BY created_at, id", messageId).map((row) => row.name);
}
