import { redirect } from '@sveltejs/kit';
import { conversationHref, scopeFrom } from '#lib/admin/helpers.ts';
import { adminApiFor, valueOrFail } from '#lib/server/admin-api.ts';
import type { PageServerLoad } from './$types';

// Opens the most recent conversation in the current scope, falling back to Everyone when My agents is empty.
export const load: PageServerLoad = async (event) => {
	const requestedScope = scopeFrom(event.url);
	const adminApi = await adminApiFor(event);
	const scoped = await valueOrFail(event, await adminApi.listConversations({ scope: requestedScope, sort: 'recent' }));
	if (scoped.conversations[0]) redirect(302, conversationHref(scoped.conversations[0].id, requestedScope));
	if (requestedScope === 'mine') {
		const everyone = await valueOrFail(event, await adminApi.listConversations({ scope: 'everyone', sort: 'recent' }));
		if (everyone.conversations[0]) redirect(302, conversationHref(everyone.conversations[0].id, 'everyone'));
	}
	return { heading: 'No conversations yet' };
};
