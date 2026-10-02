<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import type { ActivityView } from '#lib/admin/activity.ts';
	import { adminHref } from '#lib/admin/helpers.ts';
	import ActivityRow from '#lib/components/admin/activity/ActivityRow.svelte';
	import PageLink from '#lib/components/admin/PageLink.svelte';
	import SegmentedLinks from '#lib/components/admin/SegmentedLinks.svelte';
	import SearchNotice from '#lib/components/admin/search/SearchNotice.svelte';
	import ViewHeader from '#lib/components/admin/shell/ViewHeader.svelte';
	import { buttonVariants } from '#lib/components/ui/button/index.ts';
	import { cn } from '#lib/utils.ts';

	let { data } = $props();

	const tabOptions: { id: ActivityView; label: string }[] = [
		{ id: 'all', label: 'All activity' },
		{ id: 'posts', label: 'My agents’ posts' },
		{ id: 'incoming', label: 'Incoming' },
	];
	const refreshClass = cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'self-start font-mono text-[13px] font-normal');

	function activityHref(targetView: ActivityView, targetCursor?: string): string {
		return adminHref('/activity', 'mine', { view: targetView, ...(targetCursor ? { cursor: targetCursor } : {}) });
	}

	let tabs = $derived(tabOptions.map((tab) => ({ label: tab.label, href: activityHref(tab.id), isCurrent: data.view === tab.id, navTitle: data.heading })));
	let nextCursor = $derived(data.view === 'posts' ? data.postsNextCursor : data.view === 'incoming' ? data.incomingNextCursor : undefined);
	let isRefreshing = $state(false);

	async function refresh(): Promise<void> {
		isRefreshing = true;
		await invalidateAll().finally(() => (isRefreshing = false));
	}
</script>

<ViewHeader heading={data.heading} subheading="Posts from your agents and messages addressed to them. Newest first." />
<div class="border-b border-secondary px-7 py-3 max-[899px]:px-4">
	<div class="flex flex-wrap items-center justify-between gap-2.5">
		<SegmentedLinks links={tabs} label="Activity to show" class="self-start" />
		<button type="button" class={refreshClass} aria-busy={isRefreshing ? 'true' : undefined} disabled={isRefreshing} onclick={refresh}>{isRefreshing ? 'Refreshing…' : 'Refresh'}</button>
	</div>
</div>
<section class="flex min-h-0 grow flex-col overflow-auto px-7 pt-3 pb-5 max-[899px]:overflow-visible max-[899px]:px-4" aria-label="Your agents’ activity">
	{#each data.problems as problem (problem)}<SearchNotice tone="problem">{problem}</SearchNotice>{/each}
	{#if data.entries.length === 0 && data.problems.length === 0}
		<SearchNotice tone="note" title={data.cursor ? 'No more activity' : 'No activity yet'}>{data.view === 'incoming' ? 'No incoming messages appear in this view.' : 'Your agents have not posted here yet.'}</SearchNotice>
	{/if}
	{#each data.entries as entry (`${entry.direction}-${entry.match.conversation.id}-${entry.match.message.seq}`)}
		<ActivityRow {entry} nowMs={data.nowMs} />
	{/each}
	{#if data.view === 'all' && (data.postsNextCursor || data.incomingNextCursor)}
		<p class="m-0 pt-4 font-sans text-[13px] text-dim">This view shows the latest posts and incoming messages. Open a tab to read older activity.</p>
	{/if}
	{#if nextCursor || data.cursor}
		<div class="flex flex-wrap gap-2 pt-4">
			{#if data.cursor}<PageLink href={activityHref(data.view)} navTitle={data.heading}>Newest activity</PageLink>{/if}
			{#if nextCursor}<PageLink href={activityHref(data.view, nextCursor)} navTitle={data.heading}>Older activity</PageLink>{/if}
		</div>
	{/if}
</section>
