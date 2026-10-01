import type { FreeTerm } from "./query";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function termPattern(term: FreeTerm): string {
  const body = term.text.trim().split(/\s+/).map(escapeRegExp).join("\\s+");
  return term.phrase ? `(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])` : `(?<![\\p{L}\\p{N}])${body}[\\p{L}\\p{N}_]*`;
}

export function missingTerms(text: string, terms: FreeTerm[]): string[] {
  return terms.filter((term) => !new RegExp(termPattern(term), "iu").test(text)).map((term) => term.text);
}
