<script lang="ts">
	import { adminHref } from '#lib/admin/helpers.ts';
	import type { Scope, SearchSort } from '#lib/admin/types.ts';
	import Notice from '#lib/components/admin/Notice.svelte';
	import SegmentedLinks from '#lib/components/admin/SegmentedLinks.svelte';
	import SearchRefineForm from '#lib/components/admin/search/SearchRefineForm.svelte';
	import SearchResult from '#lib/components/admin/search/SearchResult.svelte';
	import { otherScope, scopeDescriptions, scopeSwitchLabels } from '#lib/components/admin/search/search-refinement.ts';
	import ViewHeader from '#lib/components/admin/shell/ViewHeader.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';

	let { data } = $props();

	const sectionHeadingClass = 'm-0 mt-2 text-xs font-normal tracking-[0.08em] text-dim uppercase';
	const sortOptions: { id: SearchSort; label: string }[] = [
		{ id: 'relevant', label: 'Most relevant' },
		{ id: 'recent', label: 'Newest first' },
	];

	function searchHref(parameters: { q?: string; scope?: Scope; sort?: SearchSort; cursor?: string }): string {
		const { scope: targetScope = data.scope, cursor: targetCursor, ...rest } = parameters;
		return adminHref('/search', targetScope, { q: data.query, sort: data.sort, ...rest, ...(targetCursor ? { cursor: targetCursor } : {}) });
	}

	let sortLinks = $derived(sortOptions.map((option) => ({ label: option.label, href: searchHref({ sort: option.id }), isCurrent: data.sort === option.id })));
	let alternateScope = $derived(otherScope(data.scope));
	let isFirstPage = $derived(data.cursor === undefined);
</script>

<ViewHeader heading={data.heading} subheading={data.subheading} />
<div class="flex flex-col gap-2.5 page-x pt-3">
	<SearchRefineForm query={data.query} scope={data.scope} sort={data.sort} />
	<div class="flex flex-wrap items-center gap-x-5 gap-y-2.5">
		<SegmentedLinks links={sortLinks} label="Sort results" />
		<p class="m-0 text-[13px] text-dim">
			Searching {scopeDescriptions[data.scope]} · <Button href={searchHref({ scope: alternateScope })} variant="link" class="h-auto p-0">{scopeSwitchLabels[alternateScope]}</Button>
		</p>
	</div>
</div>
<section class="flex grow flex-col gap-1.5 overflow-auto page-x pt-3 pb-5 max-md:overflow-visible" aria-label="Search results">
	{#if data.problem}<Notice tone="problem" title="Search could not run">{data.problem}</Notice>{/if}
	{#if data.hasNoResults}
		<Notice tone="note" title="No matches">
			<p class="m-0">Nobody's agent has written that yet. Try fewer or other words, or a prefix such as <code class="font-mono text-[13px] text-amber">deploy*</code>.</p>
			{#if data.refinements.length > 0}
				<ul class="m-0 mt-2 flex list-none flex-col gap-1 p-0 font-mono text-[13px]">
					{#each data.refinements as refinement (refinement.label)}
						<li>
							<Button href={searchHref({ q: refinement.query, scope: refinement.scope })} variant="link" class="h-auto p-0">{refinement.label}</Button>{#if refinement.query !== data.query}<span class="text-dim"> → {refinement.query}</span>{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</Notice>
	{/if}
	{#if !data.problem && data.matches.length === 0 && !isFirstPage}<Notice tone="note">No more matches.</Notice>{/if}
	{#if data.top && data.top.length > 0}
		<h2 class={sectionHeadingClass}>Best matches</h2>
		{#each data.top as match (`top-${match.conversation.id}-${match.message.seq}`)}
			<SearchResult {match} scope={data.scope} nowMs={data.nowMs} />
		{/each}
		<h2 class={sectionHeadingClass}>Newest first</h2>
	{/if}
	{#each data.matches as match (`${match.conversation.id}-${match.message.seq}`)}
		<SearchResult {match} scope={data.scope} nowMs={data.nowMs} />
	{/each}
	{#if data.nextCursor || !isFirstPage}
		<div class="mt-1.5 flex gap-2">
			{#if !isFirstPage}<Button href={searchHref({})} variant="outline" size="sm">First page</Button>{/if}
			{#if data.nextCursor}<Button href={searchHref({ cursor: data.nextCursor })} variant="outline" size="sm">More results</Button>{/if}
		</div>
	{/if}
</section>
