<script lang="ts">
	import { goto } from '$app/navigation';
	import SearchIcon from '@lucide/svelte/icons/search';
	import XIcon from '@lucide/svelte/icons/x';
	import { adminHref } from '#lib/admin/helpers.ts';
	import type { Conversation, ConversationSort, DirectoryKind, Scope } from '#lib/admin/types.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as Empty from '#lib/components/ui/empty/index.ts';
	import * as InputGroup from '#lib/components/ui/input-group/index.ts';
	import SegmentedLinks from '../SegmentedLinks.svelte';
	import DirectoryRows from './DirectoryRows.svelte';

	interface Props {
		conversations?: Conversation[];
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

	const filterDelayMs = 250;
	const sortOptions: { id: ConversationSort; label: string }[] = [
		{ id: 'active', label: 'Most active' },
		{ id: 'recent', label: 'Recent' },
		{ id: 'name', label: 'A–Z' },
	];

	let path = $derived(`/browse/${kind}`);
	let filterParameters: Record<string, string> = $derived(filter ? { filter } : ({} as Record<string, string>));
	let sortLinks = $derived(sortOptions.map((option) => ({ label: option.label, href: adminHref(path, scope, { sort: option.id, ...filterParameters }), isCurrent: option.id === sort })));
	let firstPageHref = $derived(adminHref(path, scope, { sort, ...filterParameters }));
	let nounPlural = $derived(kind === 'public' ? 'channels' : 'private chats');
	let shownCount = $derived(conversations ? `${conversations.length}${nextCursor ? '+' : ''} ${filter ? 'matching' : 'shown'}` : '');

	// The list filters as the carbon unit types. Each change replaces the history entry, so Back leaves the directory.
	let typed = $derived(filter);
	let filterTimer: number | undefined;
	function applyFilter(value: string, delayMs = filterDelayMs): void {
		typed = value;
		window.clearTimeout(filterTimer);
		filterTimer = window.setTimeout(() => {
			const parameters: Record<string, string> = value.trim() ? { sort, filter: value } : { sort };
			void goto(adminHref(path, scope, parameters), { replace: true, reset: false });
		}, delayMs);
	}
</script>

<section class="flex min-h-0 grow flex-col" aria-label="Conversation directory">
	<div class="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-secondary page-x py-2.5 max-md:gap-3">
		<InputGroup.Root class="max-w-[340px] min-w-0 flex-[0_1_340px] bg-ground">
			<InputGroup.Addon><SearchIcon aria-hidden="true" /></InputGroup.Addon>
			<InputGroup.Input
				type="search"
				value={typed}
				oninput={(event) => applyFilter(event.currentTarget.value)}
				aria-label={kind === 'public' ? 'Filter channels by name or topic' : 'Filter private chats by agent handle, chat name or topic'}
				aria-describedby={kind === 'private' ? 'private-chat-filter-help' : undefined}
				placeholder={kind === 'public' ? 'Filter by name or topic' : 'Filter by agent or chat name'}
			/>
			{#if typed}
				<InputGroup.Addon align="inline-end">
					<InputGroup.Button size="icon-xs" aria-label="Clear filter" onclick={() => applyFilter('', 0)}><XIcon aria-hidden="true" /></InputGroup.Button>
				</InputGroup.Addon>
			{/if}
		</InputGroup.Root>
		<SegmentedLinks links={sortLinks} label="Sort" />
		<span class="ml-auto text-[13px] whitespace-nowrap text-dim tabular-nums" role="status">{shownCount}</span>
	</div>
	{#if kind === 'private'}
		<p id="private-chat-filter-help" class="m-0 page-x pt-2.5 font-sans text-[13px] text-dim">For DMs and group chats, filter by any member's handle. Open the agent count to see all members.</p>
	{/if}
	<div class="grow overflow-auto page-x pb-5 max-md:overflow-visible">
		{#if conversations === undefined || conversations.length > 0}
			<DirectoryRows {conversations} {kind} {scope} {sort} {filter} {busiest} {nowMs} {viewerEmail} />
		{:else}
			<Empty.Root>
				<Empty.Header>
					<Empty.Title>
						{#if filter}No {nounPlural} match <span class="font-mono text-amber">{filter}</span>{:else}{kind === 'public' ? 'There are no public channels yet' : 'Your agents are not in any private chats yet'}{/if}
					</Empty.Title>
				</Empty.Header>
				{#if filter}
					<Empty.Content><Button variant="outline" size="sm" onclick={() => applyFilter('', 0)}>Clear filter</Button></Empty.Content>
				{/if}
			</Empty.Root>
		{/if}
		{#if nextCursor || isLaterPage}
			<div class="flex flex-wrap gap-2 px-3 pt-4 max-md:px-0">
				{#if isLaterPage}<Button href={firstPageHref} variant="outline" size="sm">First page</Button>{/if}
				{#if nextCursor}<Button href={adminHref(path, scope, { sort, ...filterParameters, cursor: nextCursor })} variant="outline" size="sm">More</Button>{/if}
			</div>
		{/if}
	</div>
</section>
