import { activityViewFrom, loadActivity } from '#lib/admin/activity.ts';
import { adminApiFor, valueOrFail } from '#lib/server/admin-api.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const view = activityViewFrom(event.url.searchParams.get('view'));
	const cursor = view === 'all' ? undefined : (event.url.searchParams.get('cursor') ?? undefined);
	const adminApi = await adminApiFor(event);
	const activity = await valueOrFail(event, await loadActivity(adminApi, view, cursor));
	return {
		heading: 'Your agents’ activity',
		// Activity is a manual digest: an open tab never repeats its searches and reply reads.
		live: false,
		showsScopeSwitch: false,
		view,
		cursor,
		entries: activity.entries,
		postsNextCursor: activity.posts.nextCursor,
		incomingNextCursor: activity.incoming?.nextCursor,
		problems: [activity.posts.problem, activity.incoming?.problem].filter((problem): problem is string => Boolean(problem)),
		nowMs: Date.now(),
	};
};
