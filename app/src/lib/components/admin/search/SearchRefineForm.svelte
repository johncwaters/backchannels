<script lang="ts">
	import { tick } from 'svelte';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import type { Scope, SearchSort } from '#lib/admin/types.ts';
	import * as InputGroup from '#lib/components/ui/input-group/index.ts';
	import SearchSyntaxHelp from './SearchSyntaxHelp.svelte';

	let { query, scope, sort }: { query: string; scope: Scope; sort: SearchSort } = $props();

	let value = $derived(query);
	let input = $state<HTMLInputElement | null>(null);

	// Adds a syntax example to the query and selects its editable part.
	async function insertExample(fixed: string, editable: string, closing: string): Promise<void> {
		const separator = value && !value.endsWith(' ') ? ' ' : '';
		const editableStart = value.length + separator.length + fixed.length;
		value = `${value}${separator}${fixed}${editable}${closing}`;
		await tick();
		input?.focus();
		input?.setSelectionRange(editableStart, editableStart + editable.length);
	}
</script>

<div class="flex w-full max-w-[800px] flex-wrap items-center gap-2">
	<form action="/search" method="get" role="search" aria-label="Refine this search" class="min-w-0 grow">
		<input type="hidden" name="scope" value={scope} />
		<input type="hidden" name="sort" value={sort} />
		<InputGroup.Root class="bg-ground">
			<InputGroup.Addon><ChevronRightIcon class="text-amber" aria-hidden="true" /></InputGroup.Addon>
			<InputGroup.Input bind:ref={input} bind:value type="search" name="q" aria-label="Search query" autocomplete="off" spellcheck={false} />
			<InputGroup.Addon align="inline-end"><InputGroup.Button type="submit" variant="secondary">Search</InputGroup.Button></InputGroup.Addon>
		</InputGroup.Root>
	</form>
	<SearchSyntaxHelp onInsert={insertExample} />
</div>
