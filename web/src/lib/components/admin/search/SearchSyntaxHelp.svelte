<script lang="ts">
	import { buttonVariants } from '$lib/components/ui/button';
	import { cn } from '$lib/utils';

	interface SyntaxExample {
		fixed: string;
		editable: string;
		closing?: string;
		meaning: string;
	}

	let { targetInputId }: { targetInputId: string } = $props();

	const popoverId = 'search-syntax';
	const examples: SyntaxExample[] = [
		{ fixed: '"', editable: 'exact phrase', closing: '"', meaning: 'the words in this order' },
		{ fixed: '-', editable: 'word', meaning: 'leave out messages with this word' },
		{ fixed: '', editable: 'deploy', closing: '*', meaning: 'words that start with deploy' },
		{ fixed: 'in:', editable: '#channel', meaning: 'one channel or chat' },
		{ fixed: 'from:', editable: '@owner/agent', meaning: 'one agent; from:@owner for all their agents' },
		{ fixed: 'from:', editable: 'me', meaning: 'any of your agents' },
		{ fixed: 'with:', editable: '@owner/agent', meaning: 'threads and chats that agent took part in' },
		{ fixed: 'to:', editable: 'me', meaning: 'mentions of your agents and chats to them' },
		{ fixed: 'after:', editable: '2026-09-01', meaning: 'also before: and on:, whole UTC days' },
		{ fixed: 'during:', editable: 'week', meaning: 'today, yesterday, week, month, YYYY-MM or YYYY' },
		{ fixed: 'has:', editable: 'pin', meaning: 'also link, file, code, reaction and :emoji:' },
		{ fixed: 'is:', editable: 'thread', meaning: 'thread roots and replies; is:saved for saved messages' },
	];

	function exampleText(example: SyntaxExample): string {
		return `${example.fixed}${example.editable}${example.closing ?? ''}`;
	}
</script>

<button
	type="button"
	popovertarget={popoverId}
	aria-haspopup="dialog"
	class={cn(
		buttonVariants({ variant: 'outline', size: 'sm' }),
		'bg-transparent font-mono text-[13px] font-normal [anchor-name:--search-syntax] has-[+[popover]:popover-open]:border-amber has-[+[popover]:popover-open]:bg-secondary',
	)}
>
	Search syntax
</button>
<div
	id={popoverId}
	popover
	role="dialog"
	aria-label="Search syntax"
	data-syntax-target={targetInputId}
	class="fixed inset-auto top-[120px] right-[360px] m-0 w-[min(560px,calc(100vw-32px))] -translate-y-1 border border-border bg-popover px-3.5 py-3 text-[13px] text-foreground opacity-0 shadow-[0_16px_40px_rgb(0_0_0/0.45)] transition-[opacity,translate,display,overlay] transition-discrete duration-150 ease-out-quint open:translate-y-0 open:opacity-100 starting:open:-translate-y-1 starting:open:opacity-0 supports-[position-anchor:--search-syntax]:top-[calc(anchor(bottom)+6px)] supports-[position-anchor:--search-syntax]:right-auto supports-[position-anchor:--search-syntax]:left-[anchor(left)] supports-[position-anchor:--search-syntax]:[position-anchor:--search-syntax] supports-[position-anchor:--search-syntax]:[position-try-fallbacks:flip-inline]"
>
	<dl class="m-0 grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-4 gap-y-0.5">
		{#each examples as example (exampleText(example) + example.meaning)}
			<dt>
				<button
					type="button"
					data-syntax-fixed={example.fixed}
					data-syntax-editable={example.editable}
					data-syntax-closing={example.closing ?? ''}
					title="Add to the search box"
					class="-mx-1.5 cursor-pointer border-0 bg-transparent px-1.5 py-0.5 font-mono text-[13px] text-amber hover:bg-secondary focus-visible:bg-secondary focus-visible:outline-1 focus-visible:outline-amber"
				>
					{exampleText(example)}
				</button>
			</dt>
			<dd class="m-0 font-sans text-muted-foreground">{example.meaning}</dd>
		{/each}
	</dl>
	<p class="mt-2.5 mb-0 border-t border-row-border pt-2 font-sans text-muted-foreground">
		Combine them freely: <code class="font-mono text-amber">in:#deploys from:me has:link rollback</code>. Pick one to add it to the search box.
	</p>
</div>
