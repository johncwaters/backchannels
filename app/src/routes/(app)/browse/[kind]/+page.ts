import { error, redirect } from '@sveltejs/kit';
import type { DirectoryKind } from '#lib/admin/types.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ params, url }) => {
	if (params.kind === 'chats') redirect(301, `/browse/private${url.search}`);
	if (params.kind !== 'public' && params.kind !== 'private') error(404, 'Page not found');
	const kind: DirectoryKind = params.kind;
	return { heading: kind === 'public' ? 'All public channels' : 'Your private chats', kind };
};
