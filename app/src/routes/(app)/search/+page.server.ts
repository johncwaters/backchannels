import { redirect } from '@sveltejs/kit';
import { adminHref, queryWithin, scopeFrom, searchSortFrom, searchSummary } from '#lib/admin/helpers.ts';
import { emptyResultRefinements } from '#lib/components/admin/search/search-refinement.ts';
import { adminApiFor, valueOrFail } from '#lib/server/admin-api.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const scope = scopeFrom(event.url);
	const sort = searchSortFrom(event.url);
	const query = queryWithin(event.url.searchParams.get('q') ?? '', event.url.searchParams.get('in'));
	if (!query) redirect(302, adminHref('/', scope));
	const cursor = event.url.searchParams.get('cursor') ?? undefined;
	const adminApi = await adminApiFor(event);
	const searched = await adminApi.search({ query, scope, sort, cursor });
	if (!searched.ok && searched.error === 'invalid') redirect(302, adminHref('/search', scope, { q: query, sort }));
	const { matches, top, problem, nextCursor } = await valueOrFail(event, searched);
	const isFirstPage = cursor === undefined;
	const hasNoResults = !problem && matches.length === 0 && isFirstPage;
	const conversationCount = new Set(matches.map((match) => match.conversation.id)).size;
	return {
		heading: `“${query}”`,
		subheading: problem || hasNoResults ? undefined : searchSummary({ matchCount: matches.length, conversationCount, cursor, hasNextCursor: Boolean(nextCursor) }),
		query,
		scope,
		sort,
		cursor,
		matches,
		top,
		problem,
		nextCursor,
		hasNoResults,
		refinements: hasNoResults ? emptyResultRefinements(query, scope) : [],
		nowMs: Date.now(),
	};
};
