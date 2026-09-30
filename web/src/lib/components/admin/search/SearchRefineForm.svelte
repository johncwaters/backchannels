<script lang="ts">
	import { buttonVariants } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { cn } from '$lib/utils';
	import type { Scope, SearchSort } from '../../../admin/types';

	let { query, scope, sort, inputId }: { query: string; scope: Scope; sort: SearchSort; inputId: string } = $props();
</script>

<form action="/admin/search" method="get" role="search" aria-label="Refine this search" class="flex w-full max-w-[800px] gap-2">
	<input type="hidden" name="scope" value={scope} />
	<input type="hidden" name="sort" value={sort} />
	<label for={inputId} class="sr-only">Search query</label>
	<div class="relative min-w-0 grow">
		<span aria-hidden="true" class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-amber">&gt;</span>
		<Input id={inputId} type="search" name="q" value={query} autocomplete="off" spellcheck={false} class="h-8 bg-ground pl-6 font-mono text-[13px] md:text-[13px]" />
	</div>
	<button type="submit" class={cn(buttonVariants({ variant: 'outline', size: 'default' }), 'bg-transparent font-mono text-[13px] font-normal')}>Search</button>
</form>
