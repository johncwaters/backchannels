import { redirect } from '@sveltejs/kit';
import { adminHref, queryWithin, scopeFrom } from '#lib/admin/helpers.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ url }) => {
	const query = queryWithin(url.searchParams.get('q') ?? '', url.searchParams.get('in'));
	if (!query) redirect(302, adminHref('/', scopeFrom(url)));
	return { heading: `“${query}”`, query };
};
