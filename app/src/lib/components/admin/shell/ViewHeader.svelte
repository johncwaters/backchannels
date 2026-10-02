<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		heading: string;
		subheading?: string;
		actions?: Snippet;
	}

	let { heading, subheading, actions }: Props = $props();
</script>

<header class="view-header flex flex-col gap-[3px] border-b border-secondary px-7 pt-3 pb-2.5 max-[899px]:px-4">
	<h1 class="m-0 text-[21px] font-semibold tracking-[-0.01em] text-amber" data-view-heading>{heading}</h1>
	{#if subheading || actions}
		<div class="flex flex-col gap-[3px]">
			{#if subheading}<p class="m-0 font-sans text-[13px] text-subheading">{subheading}</p>{/if}
			{@render actions?.()}
		</div>
	{/if}
</header>
