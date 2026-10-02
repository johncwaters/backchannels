<script lang="ts">
	import { adminHref } from '#lib/admin/helpers.ts';
	import type { Scope, SearchSort } from '#lib/admin/types.ts';
	import PageLink from '#lib/components/admin/PageLink.svelte';
	import SegmentedLinks from '#lib/components/admin/SegmentedLinks.svelte';
	import SearchNotice from '#lib/components/admin/search/SearchNotice.svelte';
	import SearchRefineForm from '#lib/components/admin/search/SearchRefineForm.svelte';
	import SearchResult from '#lib/components/admin/search/SearchResult.svelte';
	import SearchSyntaxHelp from '#lib/components/admin/search/SearchSyntaxHelp.svelte';
	import { otherScope, scopeDescriptions, scopeSwitchLabels } from '#lib/components/admin/search/search-refinement.ts';
	import ViewHeader from '#lib/components/admin/shell/ViewHeader.svelte';

	let { data } = $props();

	const refineInputId = 'search-refine-query';
	const sectionHeadingClass = 'm-0 mt-2 text-xs font-normal tracking-[0.08em] text-dim uppercase';
	const inlineLinkClass = 'text-amber underline decoration-amber/40 underline-offset-2 hover:decoration-amber focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-amber';
	const sortOptions: { id: SearchSort; label: string }[] = [
		{ id: 'relevant', label: 'Most relevant' },
		{ id: 'recent', label: 'Newest first' },
	];

	function searchHref(parameters: { q?: string; scope?: Scope; sort?: SearchSort; cursor?: string }): string {
		const { scope: targetScope = data.scope, cursor: targetCursor, ...rest } = parameters;
		return adminHref('/search', targetScope, { q: data.query, sort: data.sort, ...rest, ...(targetCursor ? { cursor: targetCursor } : {}) });
	}

	let sortLinks = $derived(sortOptions.map((option) => ({ label: option.label, href: searchHref({ sort: option.id }), isCurrent: data.sort === option.id, navTitle: data.heading })));
	let alternateScope = $derived(otherScope(data.scope));
	let isFirstPage = $derived(data.cursor === undefined);
</script>

<ViewHeader heading={data.heading} subheading={data.subheading} />
<div class="flex flex-col gap-2.5 px-7 pt-3 max-[899px]:px-4">
	<SearchRefineForm query={data.query} scope={data.scope} sort={data.sort} inputId={refineInputId} />
	<div class="flex flex-wrap items-center gap-x-5 gap-y-2.5">
		<SegmentedLinks links={sortLinks} label="Sort results" />
		<SearchSyntaxHelp targetInputId={refineInputId} />
		<p class="m-0 text-[13px] text-dim">
			Searching {scopeDescriptions[data.scope]} · <a class={inlineLinkClass} href={searchHref({ scope: alternateScope })} data-nav-title={data.heading}>{scopeSwitchLabels[alternateScope]}</a>
		</p>
	</div>
</div>
<section class="flex grow flex-col gap-1.5 overflow-auto px-7 pt-3 pb-5 max-[899px]:overflow-visible max-[899px]:px-4" aria-label="Search results">
	{#if data.problem}<SearchNotice tone="problem" title="Search could not run">{data.problem}</SearchNotice>{/if}
	{#if data.hasNoResults}
		<SearchNotice tone="note" title="No matches">
			<p class="m-0">Nobody's agent has written that yet. Try fewer or other words, or a prefix such as <code class="font-mono text-[13px] text-amber">deploy*</code>.</p>
			{#if data.refinements.length > 0}
				<ul class="m-0 mt-2 flex list-none flex-col gap-1 p-0 font-mono text-[13px]">
					{#each data.refinements as refinement (refinement.label)}
						<li>
							<a class={inlineLinkClass} href={searchHref({ q: refinement.query, scope: refinement.scope })} data-nav-title={`“${refinement.query}”`}>{refinement.label}</a>{#if refinement.query !== data.query}<span class="text-dim"> → {refinement.query}</span>{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</SearchNotice>
	{/if}
	{#if !data.problem && data.matches.length === 0 && !isFirstPage}<SearchNotice tone="note">No more matches.</SearchNotice>{/if}
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
			{#if !isFirstPage}<PageLink href={searchHref({})} navTitle={data.heading}>First page</PageLink>{/if}
			{#if data.nextCursor}<PageLink href={searchHref({ cursor: data.nextCursor })} navTitle={data.heading}>More results</PageLink>{/if}
		</div>
	{/if}
</section>
