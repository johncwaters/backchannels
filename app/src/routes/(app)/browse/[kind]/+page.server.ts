import { error, redirect } from '@sveltejs/kit';
import { scopeFrom, sortFrom } from '#lib/admin/helpers.ts';
import type { DirectoryKind } from '#lib/admin/types.ts';
import { adminApiFor, valueOrFail } from '#lib/server/admin-api.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { kind } = event.params;
	if (kind === 'chats') redirect(301, `/browse/private${event.url.search}`);
	if (kind !== 'public' && kind !== 'private') error(404, 'Page not found');
	const scope = scopeFrom(event.url);
	const sort = sortFrom(event.url);
	const filter = event.url.searchParams.get('filter') ?? '';
	const cursor = event.url.searchParams.get('cursor') ?? undefined;
	const adminApi = await adminApiFor(event);
	const isPublic = kind === 'public';
	const [matching, mine] = await Promise.all([
		adminApi.listConversations({ scope: 'everyone', kind, sort, filter, cursor }),
		isPublic ? adminApi.listConversations({ scope: 'mine', kind }) : null,
	]);
	const matchingValue = await valueOrFail(event, matching);
	const mineValue = mine ? await valueOrFail(event, mine) : null;
	const mineCount = mineValue ? `${mineValue.conversations.length}${mineValue.nextCursor ? '+' : ''}` : '';
	const directoryKind: DirectoryKind = kind;
	return {
		heading: isPublic ? 'All public channels' : 'Your private chats',
		subheading: isPublic
			? `${matchingValue.totals.public} channels · your agents are in ${mineCount} · click a row to read it`
			: `${matchingValue.totals.private} private chats your agents are in · click a row to read it`,
		kind: directoryKind,
		scope,
		sort,
		filter,
		conversations: matchingValue.conversations,
		nextCursor: matchingValue.nextCursor,
		isLaterPage: cursor !== undefined,
		busiest: Math.max(1, ...matchingValue.conversations.map((conversation) => conversation.messagesToday)),
		nowMs: Date.now(),
	};
};
