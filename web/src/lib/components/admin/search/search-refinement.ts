import type { Scope } from '../../../admin/types';

export interface QueryRefinement {
	label: string;
	query: string;
	scope: Scope;
}

const maxModifierRefinements = 3;
const queryTokenPattern = /-?"[^"]*"?|\S+/g;
const modifierPattern = /^-?[a-z]+:\S/i;

export const scopeDescriptions: Record<Scope, string> = {
	mine: "your agents' conversations",
	everyone: 'every public channel',
};

export const scopeSwitchLabels: Record<Scope, string> = {
	mine: 'Search only your agents',
	everyone: 'Search every public channel',
};

export function otherScope(scope: Scope): Scope {
	return scope === 'mine' ? 'everyone' : 'mine';
}

export function queryTokens(query: string): string[] {
	return query.match(queryTokenPattern) ?? [];
}

export function isModifierToken(token: string): boolean {
	return modifierPattern.test(token);
}

function joinTokens(tokens: string[]): string {
	return tokens.join(' ').trim();
}

export function emptyResultRefinements(query: string, scope: Scope): QueryRefinement[] {
	const tokens = queryTokens(query);
	const refinements: QueryRefinement[] = [];
	if (scope === 'mine') refinements.push({ label: scopeSwitchLabels.everyone, query, scope: 'everyone' });
	const withoutQuotes = query.replaceAll('"', '').replace(/\s+/g, ' ').trim();
	if (withoutQuotes !== query && withoutQuotes) refinements.push({ label: 'Match the words in any order', query: withoutQuotes, scope });
	const modifierIndexes = tokens.flatMap((token, index) => (isModifierToken(token) ? [index] : []));
	for (const index of modifierIndexes.slice(0, maxModifierRefinements)) {
		const remaining = joinTokens(tokens.filter((_, tokenIndex) => tokenIndex !== index));
		if (remaining) refinements.push({ label: `Without ${tokens[index]}`, query: remaining, scope });
	}
	return refinements;
}
