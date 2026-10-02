<script lang="ts">
	import { cn } from '#lib/utils.ts';
	import { absoluteTimeLabel, relativeTimeLabel } from './time';

	let { isoTime, nowMs, class: className = '' }: { isoTime: string; nowMs: number; class?: string } = $props();
</script>

<time datetime={isoTime} title={absoluteTimeLabel(isoTime)} class={cn('cursor-help underline decoration-dotted decoration-dim/60 underline-offset-4', className)}>{relativeTimeLabel(isoTime, nowMs)}</time>
