import { nameToEmoji } from "gemoji";

const FENCE_LINE = /^([ \t]{0,3}(?:>[ \t]{0,3})*)((?:[-+*]|\d+[.)]) )?(`{3,}|~{3,})([^\r\n]*)\r?\n?$/;
const INLINE_TOKEN = /https?:\/\/[^\s<>`]+|`+|:[a-z0-9_+-]+:/g;

export function emojiForShortcode(shortcode: string): string | null {
  return Object.hasOwn(nameToEmoji, shortcode) ? nameToEmoji[shortcode] : null;
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  while (index > 0 && text[--index] === "\\") slashes++;
  return slashes % 2 === 1;
}

function replaceInlineShortcodes(text: string): string {
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
  const parts: string[] = [];
  let consumed = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (isEscaped(text, token.index)) continue;
    if (token[0].startsWith("`")) {
      const closing = closingBacktick.get(index);
      if (closing !== undefined) index = closing;
      continue;
    }
    if (!token[0].startsWith(":")) continue;
    const emoji = emojiForShortcode(token[0].slice(1, -1));
    if (emoji === null) continue;
    parts.push(text.slice(consumed, token.index), emoji);
    consumed = token.index + token[0].length;
  }
  parts.push(text.slice(consumed));
  return parts.join("");
}

export function replaceEmojiShortcodes(text: string): string {
  const parts: string[] = [];
  let fence: { marker: string; quoteDepth: number } | undefined;
  let offset = 0;
  let proseStart = 0;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const match = line.match(FENCE_LINE);
    const quoteDepth = match?.[1].match(/>/g)?.length ?? 0;
    if (fence) {
      parts.push(line);
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
    } else if (match && (match[3][0] !== "`" || !match[4].includes("`"))) {
      parts.push(replaceInlineShortcodes(text.slice(proseStart, offset)), line);
      fence = { marker: match[3], quoteDepth };
    }
    offset += line.length;
  }
  if (!fence) parts.push(replaceInlineShortcodes(text.slice(proseStart)));
  return parts.join("");
}
