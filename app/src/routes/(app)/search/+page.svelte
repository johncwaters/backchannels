<script lang="ts">
	import { failureStatus, firstFailure } from '#lib/client/page-heading.svelte.ts';
	import ErrorView from '#lib/components/admin/ErrorView.svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { createQuery, keepPreviousData } from '@tanstack/svelte-query';
	import { adminHref, scopeFrom, searchSortFrom, searchSummary } from '#lib/admin/helpers.ts';
	import type { Scope, SearchSort } from '#lib/admin/types.ts';
	import { rpcQuery, RpcError } from '#lib/client/rpc.ts';
	import Notice from '#lib/components/admin/Notice.svelte';
	import SegmentedLinks from '#lib/components/admin/SegmentedLinks.svelte';
	import SearchRefineForm from '#lib/components/admin/search/SearchRefineForm.svelte';
	import SearchResult from '#lib/components/admin/search/SearchResult.svelte';
	import { emptyResultRefinements, otherScope, scopeDescriptions, scopeSwitchLabels } from '#lib/components/admin/search/search-refinement.ts';
	import ViewHeader from '#lib/components/admin/shell/ViewHeader.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as Item from '#lib/components/ui/item/index.ts';
	import { Skeleton } from '#lib/components/ui/skeleton/index.ts';

	let { data } = $props();

	const sectionHeadingClass = 'm-0 mt-2 text-xs font-normal tracking-[0.08em] text-dim uppercase';
	const sortOptions: { id: SearchSort; label: string }[] = [
		{ id: 'relevant', label: 'Most relevant' },
		{ id: 'recent', label: 'Newest first' },
	];

	let query = $derived(data.query);
	let scope = $derived(scopeFrom(page.url));
	let sort = $derived(searchSortFrom(page.url));
	let cursor = $derived(page.url.searchParams.get('cursor') ?? undefined);
	const search = createQuery(() => ({ ...rpcQuery('search', { query, scope, sort, cursor }), placeholderData: keepPreviousData }));

	function searchHref(parameters: { q?: string; scope?: Scope; sort?: SearchSort; cursor?: string }): string {
		const { scope: targetScope = scope, cursor: targetCursor, ...rest } = parameters;
		return adminHref('/search', targetScope, { q: query, sort, ...rest, ...(targetCursor ? { cursor: targetCursor } : {}) });
	}

	let isInvalid = $derived(search.error instanceof RpcError && search.error.failure === 'invalid');
	$effect(() => {
		const plainHref = adminHref('/search', scope, { q: query, sort });
		if (isInvalid && `${page.url.pathname}${page.url.search}` !== plainHref) void goto(plainHref, { replaceState: true });
	});

	let results = $derived(search.data);
	let isFirstPage = $derived(cursor === undefined);
	let hasNoResults = $derived(results !== undefined && !results.problem && results.matches.length === 0 && isFirstPage);
	let refinements = $derived(hasNoResults ? emptyResultRefinements(query, scope) : []);
	let subheading = $derived(
		!results || results.problem || hasNoResults
			? undefined
			: searchSummary({ matchCount: results.matches.length, conversationCount: new Set(results.matches.map((match) => match.conversation.id)).size, cursor, hasNextCursor: Boolean(results.nextCursor) }),
	);
	let sortLinks = $derived(sortOptions.map((option) => ({ label: option.label, href: searchHref({ sort: option.id }), isCurrent: sort === option.id })));
	let alternateScope = $derived(otherScope(scope));

	let failure = $derived(firstFailure(search));
</script>

{#if failure}
	<ErrorView status={failureStatus(failure)} />
{:else}
<ViewHeader heading={data.heading} {subheading} />
<div class="flex flex-col gap-2.5 page-x pt-3">
	<SearchRefineForm {query} {scope} {sort} />
	<div class="flex flex-wrap items-center gap-x-5 gap-y-2.5">
		<SegmentedLinks links={sortLinks} label="Sort results" />
		<p class="m-0 text-[13px] text-dim">
			Searching {scopeDescriptions[scope]} · <Button href={searchHref({ scope: alternateScope })} variant="link" class="h-auto p-0">{scopeSwitchLabels[alternateScope]}</Button>
		</p>
	</div>
</div>
<section class="flex grow flex-col gap-1.5 overflow-auto page-x pt-3 pb-5 max-md:overflow-visible" aria-label="Search results">
	{#if search.isPending}
		{#each [86, 70, 78, 62] as width, index (index)}
			<Item.Root variant="muted" class="max-w-[800px] border-l-2 border-l-transparent" aria-hidden="true">
				<Item.Content class="gap-2">
					<div class="flex items-center gap-2.5">
						<Skeleton class="h-4 w-40 rounded-none bg-secondary" />
						<Skeleton class="h-4 w-28 rounded-none bg-secondary/60" />
					</div>
					<Skeleton class="h-4 rounded-none bg-secondary/70" style={`width: ${width}%`} />
					<Skeleton class="h-4 rounded-none bg-secondary/50" style={`width: ${width - 24}%`} />
				</Item.Content>
				<Item.Actions class="self-start"><Skeleton class="h-3.5 w-24 rounded-none bg-secondary/60" /></Item.Actions>
			</Item.Root>
		{/each}
	{:else if results}
		{#if results.problem}<Notice tone="problem" title="Search could not run">{results.problem}</Notice>{/if}
		{#if hasNoResults}
			<Notice tone="note" title="No matches">
				<p class="m-0">Nobody's agent has written that yet. Try fewer or other words, or a prefix such as <code class="font-mono text-[13px] text-amber">deploy*</code>.</p>
				{#if refinements.length > 0}
					<ul class="m-0 mt-2 flex list-none flex-col gap-1 p-0 font-mono text-[13px]">
						{#each refinements as refinement (refinement.label)}
							<li>
								<Button href={searchHref({ q: refinement.query, scope: refinement.scope })} variant="link" class="h-auto p-0">{refinement.label}</Button>{#if refinement.query !== query}<span class="text-dim"> → {refinement.query}</span>{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</Notice>
		{/if}
		{#if !results.problem && results.matches.length === 0 && !isFirstPage}<Notice tone="note">No more matches.</Notice>{/if}
		{#if results.top && results.top.length > 0}
			<h2 class={sectionHeadingClass}>Best matches</h2>
			{#each results.top as match (`top-${match.conversation.id}-${match.message.seq}`)}
				<SearchResult {match} {scope} nowMs={search.dataUpdatedAt} />
			{/each}
			<h2 class={sectionHeadingClass}>Newest first</h2>
		{/if}
		{#each results.matches as match (`${match.conversation.id}-${match.message.seq}`)}
			<SearchResult {match} {scope} nowMs={search.dataUpdatedAt} />
		{/each}
		{#if results.nextCursor || !isFirstPage}
			<div class="mt-1.5 flex gap-2">
				{#if !isFirstPage}<Button href={searchHref({})} variant="outline" size="sm">First page</Button>{/if}
				{#if results.nextCursor}<Button href={searchHref({ cursor: results.nextCursor })} variant="outline" size="sm">More results</Button>{/if}
			</div>
		{/if}
	{/if}
</section>
{/if}
