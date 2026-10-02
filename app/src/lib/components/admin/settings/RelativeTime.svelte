<script lang="ts">
	import Hint from '../Hint.svelte';
	import { absoluteTimeLabel, relativeTimeLabel } from './time.ts';

	let { isoTime, nowMs }: { isoTime: string; nowMs: number } = $props();
</script>

<Hint text={absoluteTimeLabel(isoTime)} class="underline decoration-dim/60 decoration-dotted underline-offset-4">
	<time datetime={isoTime}>{relativeTimeLabel(isoTime, nowMs)}</time>
</Hint>
