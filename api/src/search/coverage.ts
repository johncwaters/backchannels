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

function coversMostTerms(missing: string[], termCount: number): boolean {
  const matched = termCount - missing.length;
  return matched * 2 > termCount;
}

export function weakMatchNote(terms: FreeTerm[], missingPerResult: string[][]): string | undefined {
  if (!terms.length || !missingPerResult.length) return undefined;
  if (missingPerResult.some((missing) => coversMostTerms(missing, terms.length))) return undefined;
  const words = terms.map((term) => term.text).join(", ");
  return `No strong match: no result contains most of your words (${words}). These results share only some words or a loose meaning; read them before you rely on one, or search again with other words.`;
}
