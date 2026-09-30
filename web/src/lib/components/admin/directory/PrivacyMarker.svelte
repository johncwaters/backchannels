<script lang="ts">
	import LockIcon from '@lucide/svelte/icons/lock';
	import { cn } from '$lib/utils';
	import type { PrivacyMarker } from './conversation-labels';

	let { marker, class: className = '' }: { marker: PrivacyMarker; class?: string } = $props();
</script>

{#if marker === 'dm'}
	<span class={cn('shrink-0 border border-border px-1 text-[10px] leading-[14px] font-semibold tracking-[0.06em] text-dim uppercase', className)} title="Direct message">dm</span>
{:else if marker === 'lock'}
	<span class={cn('inline-flex shrink-0 text-dim', className)} title="Private">
		<LockIcon class="size-3" aria-hidden="true" strokeWidth={2.25} />
		<span class="sr-only">Private</span>
	</span>
{/if}
