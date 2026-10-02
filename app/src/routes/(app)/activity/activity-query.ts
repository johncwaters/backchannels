import { applyReplyRead, entriesForView, incomingEntriesFrom, replyContexts, replyReadLimit, type ActivityEntry, type ActivityView } from '#lib/admin/activity.ts';
import { rpc, RpcError } from '#lib/client/rpc.ts';

export interface ActivityDigest {
	view: ActivityView;
	cursor?: string;
	entries: ActivityEntry[];
	postsNextCursor?: string;
	incomingNextCursor?: string;
	problems: string[];
}

function recentSearch(query: string, cursor?: string) {
	return rpc('search', { query, scope: 'everyone', sort: 'recent', ...(cursor ? { cursor } : {}) });
}

function nullUnlessUnauthorized(failure: unknown): null {
	if (failure instanceof RpcError && failure.failure === 'unauthorized') throw failure;
	return null;
}

async function loadActivityDigest(view: ActivityView, cursor?: string): Promise<ActivityDigest> {
	const [posts, incoming] = await Promise.all([recentSearch('from:me', view === 'posts' ? cursor : undefined), view === 'posts' ? undefined : recentSearch('to:me', view === 'incoming' ? cursor : undefined)]);
	const ownPosts = posts.matches.filter((match) => match.message.isOwn);
	const incomingEntries = incomingEntriesFrom(incoming?.matches ?? [], ownPosts);
	await Promise.all(
		replyContexts(incomingEntries).map(async (context) => {
			const read = await rpc('readConversation', { conversation: context.conversation, thread: context.thread, after: context.after, limit: replyReadLimit }).catch(nullUnlessUnauthorized);
			if (read) applyReplyRead(context, read);
		}),
	);
	return {
		view,
		cursor,
		entries: entriesForView(view, ownPosts, incomingEntries),
		postsNextCursor: posts.nextCursor,
		incomingNextCursor: incoming?.nextCursor,
		problems: [posts.problem, incoming?.problem].filter((problem): problem is string => Boolean(problem)),
	};
}

export function activityQuery(view: ActivityView, cursor?: string) {
	return { queryKey: ['activity', view, cursor ?? null] as const, queryFn: () => loadActivityDigest(view, cursor) };
}
