import { nameToEmoji } from "gemoji";

const FENCE_LINE = /^([ \t]{0,3}(?:>[ \t]{0,3})*)((?:[-+*]|\d+[.)]) )?(`{3,}|~{3,})([^\r\n]*)\r?\n?$/;
const INLINE_TOKEN = /https?:\/\/[^\s<>`]+|`+|:[a-z0-9_+-]+:/g;

export interface EmojiShortcodeReplacement {
  start: number;
  end: number;
  emoji: string;
}

type RecordReplacement = (replacement: EmojiShortcodeReplacement) => void;

export function emojiForShortcode(shortcode: string): string | null {
  return Object.hasOwn(nameToEmoji, shortcode) ? nameToEmoji[shortcode] : null;
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  while (index > 0 && text[--index] === "\\") slashes++;
  return slashes % 2 === 1;
}

function* walkInlineProseRanges(text: string, sourceOffset: number): Generator<{ start: number; end: number }> {
  const tokens = [...text.matchAll(INLINE_TOKEN)];
  const nextBacktick = new Map<number, number>();
  const closingBacktick = new Map<number, number>();
  for (let index = tokens.length - 1; index >= 0; index--) {
    const token = tokens[index][0];
    if (!token.startsWith("`")) continue;
    const next = nextBacktick.get(token.length);
    if (next !== undefined) closingBacktick.set(index, next);
    nextBacktick.set(token.length, index);
  }
  let consumed = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token[0].startsWith(":")) continue;
    if (token[0].startsWith("`")) {
      if (isEscaped(text, token.index)) continue;
      const closing = closingBacktick.get(index);
      if (closing === undefined) continue;
      yield { start: sourceOffset + consumed, end: sourceOffset + token.index };
      consumed = tokens[closing].index + tokens[closing][0].length;
      index = closing;
      continue;
    }
    yield { start: sourceOffset + consumed, end: sourceOffset + token.index };
    consumed = token.index + token[0].length;
  }
  yield { start: sourceOffset + consumed, end: sourceOffset + text.length };
}

function* walkProseRanges(text: string): Generator<{ start: number; end: number }> {
  let fence: { marker: string; quoteDepth: number } | undefined;
  let offset = 0;
  let proseStart = 0;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const match = line.match(FENCE_LINE);
    const quoteDepth = match?.[1].match(/>/g)?.length ?? 0;
    if (fence) {
      if (
        match &&
        !match[2] &&
        quoteDepth === fence.quoteDepth &&
        match[3][0] === fence.marker[0] &&
        match[3].length >= fence.marker.length &&
        !match[4].trim()
      ) {
        fence = undefined;
        proseStart = offset + line.length;
      }
      offset += line.length;
      continue;
    }
    if (match && (match[3][0] !== "`" || !match[4].includes("`"))) {
      yield* walkInlineProseRanges(text.slice(proseStart, offset), proseStart);
      fence = { marker: match[3], quoteDepth };
    }
    offset += line.length;
  }
  if (!fence) yield* walkInlineProseRanges(text.slice(proseStart), proseStart);
}

export function maskCode(text: string): string {
  const parts: string[] = [];
  let consumed = 0;
  for (const range of walkProseRanges(text)) {
    parts.push(text.slice(consumed, range.start).replace(/[^\r\n]/g, " "), text.slice(range.start, range.end));
    consumed = range.end;
  }
  parts.push(text.slice(consumed).replace(/[^\r\n]/g, " "));
  return parts.join("");
}

export function replaceEmojiShortcodes(text: string, recordReplacement?: RecordReplacement): string {
  const parts: string[] = [];
  let consumed = 0;
  for (const range of walkProseRanges(text)) {
    for (const token of text.slice(range.start, range.end).matchAll(INLINE_TOKEN)) {
      const start = range.start + token.index;
      if (!token[0].startsWith(":") || isEscaped(text, start)) continue;
      const emoji = emojiForShortcode(token[0].slice(1, -1));
      if (emoji === null) continue;
      const end = start + token[0].length;
      recordReplacement?.({ start, end, emoji });
      parts.push(text.slice(consumed, start), emoji);
      consumed = end;
    }
  }
  parts.push(text.slice(consumed));
  return parts.join("");
}

export function replaceEmojiShortcodesWithPositions(text: string): { text: string; replacements: EmojiShortcodeReplacement[] } {
  const replacements: EmojiShortcodeReplacement[] = [];
  const converted = replaceEmojiShortcodes(text, (replacement) => replacements.push(replacement));
  return { text: converted, replacements };
}
