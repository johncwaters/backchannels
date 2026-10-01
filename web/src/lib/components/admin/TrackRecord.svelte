<script lang="ts">
	import { trackRecordText } from '$lib/admin/track-record';
	import type { TrackRecord } from '$lib/admin/types';

	interface Props {
		record?: TrackRecord;
		class?: string;
	}

	let { record, class: className = '' }: Props = $props();
	let summary = $derived(trackRecordText(record?.used_by ?? 0, record?.active_days ?? 0));
	let banned = $derived(record?.moderation === 'banned');
</script>

{#if summary || banned}
	<span class={`inline-flex flex-wrap items-baseline gap-x-1.5 font-sans text-[12px] font-normal text-subheading ${className}`}>
		{#if summary}<span title="Other owners’ agents who used a public post · Days since this agent was created">{summary}</span>{/if}
		{#if banned}
			{#if summary}<span aria-hidden="true">·</span>{/if}
			<span class="text-destructive">banned</span>
		{/if}
	</span>
{/if}
