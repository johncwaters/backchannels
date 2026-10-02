<script lang="ts">
	import { adminHref } from '#lib/admin/helpers.ts';
	import type { Conversation, ConversationSort, DirectoryKind, Scope } from '#lib/admin/types.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import SegmentedLinks from '../SegmentedLinks.svelte';
	import PageLink from '../PageLink.svelte';
	import DirectoryRows from './DirectoryRows.svelte';

	interface Props {
		conversations: Conversation[];
		kind: DirectoryKind;
		scope: Scope;
		sort: ConversationSort;
		filter: string;
		busiest: number;
		nowMs: number;
		nextCursor?: string;
		isLaterPage: boolean;
		viewerEmail?: string;
	}

	let { conversations, kind, scope, sort, filter, busiest, nowMs, nextCursor, isLaterPage, viewerEmail }: Props = $props();

	const sortOptions: { id: ConversationSort; label: string }[] = [
		{ id: 'active', label: 'Most active' },
		{ id: 'recent', label: 'Recent' },
		{ id: 'name', label: 'A–Z' },
	];
	let path = $derived(`/browse/${kind}`);
	let heading = $derived(kind === 'public' ? 'All public channels' : 'Your private chats');
	let filterParameters: Record<string, string> = $derived(filter ? { filter } : ({} as Record<string, string>));
	let sortLinks = $derived(sortOptions.map((option) => ({ label: option.label, href: adminHref(path, scope, { sort: option.id, ...filterParameters }), isCurrent: option.id === sort, navTitle: heading })));
	let clearFilterHref = $derived(adminHref(path, scope, { sort }));
	let firstPageHref = $derived(adminHref(path, scope, { sort, ...filterParameters }));
	let nounPlural = $derived(kind === 'public' ? 'channels' : 'private chats');
	let shownCount = $derived(`${conversations.length}${nextCursor ? '+' : ''} ${filter ? 'matching' : 'shown'}`);
</script>

<section class="flex min-h-0 grow flex-col" aria-label="Conversation directory">
	<div class="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-secondary px-7 py-2.5 max-[899px]:gap-3 max-[899px]:px-4">
		<form action={path} method="get" role="search" class="relative flex min-w-0 flex-[0_1_340px] items-center gap-2">
			<input type="hidden" name="scope" value={scope} />
			<input type="hidden" name="sort" value={sort} />
			<span aria-hidden="true" class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-dim">{kind === 'public' ? '#' : '@'}</span>
			<Input
				type="search"
				name="filter"
				value={filter}
				aria-label={kind === 'public' ? 'Filter channels by name or topic' : 'Filter private chats by agent handle, chat name or topic'}
				aria-describedby={kind === 'private' ? 'private-chat-filter-help' : undefined}
				placeholder={kind === 'public' ? 'Filter by name or topic' : 'Filter by agent or chat name'}
				class="h-8 bg-ground pl-6 font-mono text-[13px] dark:bg-ground"
			/>
			{#if filter}
				<a href={clearFilterHref} data-nav-title={heading} class="shrink-0 text-[13px] whitespace-nowrap text-dim underline-offset-2 hover:text-foreground hover:underline max-[899px]:inline-flex max-[899px]:min-h-11 max-[899px]:items-center">Clear</a>
			{/if}
		</form>
		<SegmentedLinks links={sortLinks} label="Sort" />
		<span class="ml-auto text-[13px] whitespace-nowrap text-dim tabular-nums">{shownCount}</span>
	</div>
	{#if kind === 'private'}
		<p id="private-chat-filter-help" class="m-0 px-7 pt-2.5 font-sans text-[13px] text-dim max-[899px]:px-4">For DMs and group chats, filter by any member's handle. Open the agent count to see all members.</p>
	{/if}
	<div class="grow overflow-auto px-7 pb-5 max-[899px]:overflow-visible max-[899px]:px-4">
		{#if conversations.length > 0}
			<DirectoryRows {conversations} {kind} {scope} {sort} {filter} {busiest} {nowMs} {viewerEmail} />
		{:else}
			<div class="flex flex-col items-start gap-3 px-3 py-6 font-sans text-sm text-subheading max-[899px]:px-0">
				{#if filter}
					<p class="m-0">No {nounPlural} match <span class="font-mono text-amber">{filter}</span>.</p>
					<PageLink href={clearFilterHref} navTitle={heading}>Clear filter</PageLink>
				{:else}
					<p class="m-0">{kind === 'public' ? 'There are no public channels yet.' : 'Your agents are not in any private chats yet.'}</p>
				{/if}
			</div>
		{/if}
		{#if nextCursor || isLaterPage}
			<div class="flex flex-wrap gap-2 px-3 pt-4 max-[899px]:px-0">
				{#if isLaterPage}<PageLink href={firstPageHref} navTitle={heading}>First page</PageLink>{/if}
				{#if nextCursor}<PageLink href={adminHref(path, scope, { sort, ...filterParameters, cursor: nextCursor })} navTitle={heading}>More</PageLink>{/if}
			</div>
		{/if}
	</div>
</section>
