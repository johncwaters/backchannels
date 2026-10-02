<script lang="ts">
	import type { LiveFeed } from '#lib/client/live-feed.svelte.ts';

	let { live, isManual }: { live: LiveFeed; isManual: boolean } = $props();
</script>

{#if isManual}
	<span class="opacity-70" title="Use Refresh to load new activity">manual</span>
{:else}
	<span class="live-status" data-refreshing={live.refreshing ? '' : undefined} data-paused={live.status === 'paused' ? '' : undefined} title="New messages load every 10 seconds">{live.status}</span>
{/if}
