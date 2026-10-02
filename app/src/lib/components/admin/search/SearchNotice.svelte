<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '#lib/utils.ts';

	type NoticeTone = 'note' | 'problem';

	let { tone, title, children }: { tone: NoticeTone; title?: string; children: Snippet } = $props();

	const toneClasses: Record<NoticeTone, string> = {
		note: 'border-amber text-subheading',
		problem: 'border-destructive text-foreground',
	};
	const titleClasses: Record<NoticeTone, string> = {
		note: 'text-amber',
		problem: 'text-destructive',
	};
</script>

<div role={tone === 'problem' ? 'alert' : 'status'} class={cn('flex max-w-[800px] flex-col gap-1 border-l-2 bg-sidebar px-3.5 py-2.5', toneClasses[tone])}>
	{#if title}
		<p class={cn('m-0 font-mono text-xs tracking-[0.08em] uppercase', titleClasses[tone])}>{title}</p>
	{/if}
	<div class="font-sans text-[15px] leading-normal">
		{@render children()}
	</div>
</div>
