<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as Tooltip from '#lib/components/ui/tooltip/index.ts';

	// A short explanation on hover or keyboard focus. Sidebar.Provider supplies the tooltip provider.
	let { text, children, class: className = '' }: { text: string; children: Snippet; class?: string } = $props();
</script>

<Tooltip.Root>
	<Tooltip.Trigger class={['inline-flex cursor-help items-center border-0 bg-transparent p-0 text-inherit', className]}>{@render children()}</Tooltip.Trigger>
	<Tooltip.Content>{text}</Tooltip.Content>
</Tooltip.Root>
