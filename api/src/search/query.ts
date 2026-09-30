import { SEARCH, STOP_WORDS } from "./config";

export type SortOrder = "relevant" | "recent";

export interface FreeTerm {
  text: string;
  phrase: boolean;
  prefix: boolean;
}

export const MODIFIER_KEYS = ["in", "from", "with", "to", "before", "after", "on", "during", "has", "is"] as const;
export type ModifierKey = (typeof MODIFIER_KEYS)[number];

export interface Modifier {
  key: ModifierKey;
  value: string;
}

export interface ParsedQuery {
  include: FreeTerm[];
  exclude: FreeTerm[];
  modifiers: Modifier[];
  freeText: string;
}

const TOKEN = /-?"[^"]*"?|\S+/g;
const MODIFIER = /^([a-z]+):(.+)$/i;
const HAS_WORD_CHARACTER = /[\p{L}\p{N}]/u;

function isModifierKey(key: string): key is ModifierKey {
  return (MODIFIER_KEYS as readonly string[]).includes(key);
}

function unquote(value: string): string {
  return value.replace(/^"/, "").replace(/"$/, "");
}

function toTerm(raw: string): FreeTerm | null {
  if (raw.startsWith('"')) {
    const text = unquote(raw).trim();
    return HAS_WORD_CHARACTER.test(text) ? { text, phrase: true, prefix: false } : null;
  }
  const isPrefix = raw.endsWith("*") && raw.length - 1 >= SEARCH.prefixMinLength;
  const text = raw.replace(/\*+$/, "");
  return HAS_WORD_CHARACTER.test(text) ? { text, phrase: false, prefix: isPrefix } : null;
}

export function parseQuery(query: string): ParsedQuery {
  const include: FreeTerm[] = [];
  const exclude: FreeTerm[] = [];
  const modifiers: Modifier[] = [];
  for (const token of query.match(TOKEN) ?? []) {
    const excluded = token.length > 1 && token.startsWith("-");
    const raw = excluded ? token.slice(1) : token;
    const modifier = !excluded && !raw.startsWith('"') ? MODIFIER.exec(raw) : null;
    if (modifier && isModifierKey(modifier[1].toLowerCase())) {
      modifiers.push({ key: modifier[1].toLowerCase() as ModifierKey, value: unquote(modifier[2]) });
      continue;
    }
    const term = toTerm(raw);
    if (term) (excluded ? exclude : include).push(term);
  }
  return { include, exclude, modifiers, freeText: include.map((term) => term.text).join(" ") };
}

export function withoutStopWords(terms: FreeTerm[]): FreeTerm[] {
  const kept = terms.filter((term) => term.phrase || term.prefix || !STOP_WORDS.has(term.text.toLowerCase()));
  return kept.length ? kept : terms;
}

function quoteForFts(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

function ftsTerm(term: FreeTerm): string {
  return term.prefix ? `${quoteForFts(term.text)}*` : quoteForFts(term.text);
}

export function ftsMatch(terms: FreeTerm[], joiner: "OR" | "AND"): string {
  return terms.map(ftsTerm).join(` ${joiner} `);
}
