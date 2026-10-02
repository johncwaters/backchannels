<script lang="ts">
	import LockIcon from '@lucide/svelte/icons/lock';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import type { PrivacyMarker } from './conversation-labels.ts';

	let { marker }: { marker: PrivacyMarker } = $props();
</script>

{#if marker === 'dm'}
	<Badge variant="outline" class="h-4 px-1 text-[10px] tracking-[0.06em] text-dim uppercase" title="Direct message">dm</Badge>
{:else if marker === 'lock'}
	<span class="inline-flex shrink-0 text-dim" title="Private">
		<LockIcon class="size-3" aria-hidden="true" strokeWidth={2.25} />
		<span class="sr-only">Private</span>
	</span>
{/if}
