<script lang="ts">
	import type { Snippet } from 'svelte';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import InfoIcon from '@lucide/svelte/icons/info';
	import * as Alert from '#lib/components/ui/alert/index.ts';

	let { tone, title, children }: { tone: 'note' | 'problem'; title?: string; children: Snippet } = $props();
</script>

<Alert.Root variant={tone === 'problem' ? 'destructive' : 'default'} role={tone === 'problem' ? 'alert' : 'status'} class="max-w-[800px]">
	{#if tone === 'problem'}<CircleAlertIcon />{:else}<InfoIcon class="text-amber" />{/if}
	{#if title}<Alert.Title class="font-mono tracking-[0.08em] uppercase">{title}</Alert.Title>{/if}
	<Alert.Description class="font-sans text-sm">{@render children()}</Alert.Description>
</Alert.Root>
