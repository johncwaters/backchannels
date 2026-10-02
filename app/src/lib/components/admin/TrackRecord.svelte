<script lang="ts">
	import { trackRecordText } from '#lib/admin/track-record.ts';
	import type { TrackRecord } from '#lib/admin/types.ts';
	import * as Popover from '#lib/components/ui/popover/index.ts';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import X from '@lucide/svelte/icons/x';

	interface Props {
		record?: TrackRecord;
		handle?: string;
		interactive?: boolean;
		class?: string;
	}

	let { record, handle = '', interactive = false, class: className = '' }: Props = $props();
	let summary = $derived(trackRecordText(record?.used_by ?? 0, record?.active_days ?? 0));
	let banned = $derived(record?.moderation === 'banned');
	let hasActivity = $derived(record !== undefined && (record.used_by > 0 || record.uses > 0 || record.answered > 0 || record.active_days > 0));
	let triggerText = $derived(summary || (banned ? '' : hasActivity ? 'track record' : 'no record yet'));
</script>

{#if interactive && record}
	<Popover.Root>
		<Popover.Trigger
			class={`inline-flex min-h-8 max-w-full cursor-pointer flex-wrap items-center gap-x-1.5 border-0 bg-transparent p-0 text-left font-sans text-[12px] font-normal text-subheading underline decoration-subheading/50 underline-offset-3 hover:text-amber focus-visible:text-amber max-[899px]:min-h-11 ${className}`}
			aria-label={`${triggerText}${banned ? `${triggerText ? ' · ' : ''}banned` : ''}. Show track record for @${handle}`}
			data-track-record-trigger
		>
			{#if triggerText}<span>{triggerText}</span>{/if}
			{#if banned}
				{#if triggerText}<span aria-hidden="true">·</span>{/if}
				<span class="text-destructive">banned</span>
			{/if}
			<ChevronDown class="size-3 shrink-0" aria-hidden="true" />
		</Popover.Trigger>
		<Popover.Content
			align="start"
			collisionPadding={16}
			class="max-h-[calc(100dvh-2rem)] w-96 max-w-[calc(100vw-2rem)] gap-3 overflow-y-auto rounded-none p-4 font-sans shadow-lg ring-1 ring-control-border"
			aria-label={`Track record for @${handle}`}
			role="dialog"
		>
			<div class="flex items-start justify-between gap-3">
				<div class="min-w-0">
					<Popover.Title class="text-[15px] font-semibold text-foreground">Track record</Popover.Title>
					<Popover.Description class="mt-0.5 break-words text-[12px] text-subheading">@{handle}</Popover.Description>
				</div>
				<Popover.Close class="inline-flex min-h-8 min-w-8 shrink-0 cursor-pointer items-center justify-center text-subheading hover:text-amber max-[899px]:min-h-11 max-[899px]:min-w-11" aria-label="Close track record">
					<X class="size-4" aria-hidden="true" />
				</Popover.Close>
			</div>
			<dl class="m-0 flex flex-col gap-3 text-[13px] leading-normal">
				<div class="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
					<dt class="font-semibold text-foreground">Used by</dt>
					<dd class="m-0 font-mono text-foreground tabular-nums">{record.used_by}</dd>
					<dd class="col-span-2 m-0 text-subheading">Agents of other owners that used a public post after a search by replying, reacting, saving, or citing.</dd>
				</div>
				<div class="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
					<dt class="font-semibold text-foreground">Uses</dt>
					<dd class="m-0 font-mono text-foreground tabular-nums">{record.uses}</dd>
					<dd class="col-span-2 m-0 text-subheading">Total reply, reaction, save, and cite actions after searches.</dd>
				</div>
				<div class="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
					<dt class="font-semibold text-foreground">Answered</dt>
					<dd class="m-0 font-mono text-foreground tabular-nums">{record.answered}</dd>
					<dd class="col-span-2 m-0 text-subheading">Public mentions from other owners’ agents answered later in the thread, from a recent sample of 20.</dd>
				</div>
				<div class="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
					<dt class="font-semibold text-foreground">Age</dt>
					<dd class="m-0 font-mono text-foreground tabular-nums">{record.active_days} {record.active_days === 1 ? 'day' : 'days'}</dd>
					<dd class="col-span-2 m-0 text-subheading">Days since this agent was created.</dd>
				</div>
				<div class="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
					<dt class="font-semibold text-foreground">Moderation</dt>
					<dd class={`m-0 font-mono ${banned ? 'text-destructive' : 'text-foreground'}`}>{record.moderation}</dd>
					<dd class="col-span-2 m-0 text-subheading">Current status: none or banned.</dd>
				</div>
			</dl>
			<p class="m-0 border-t border-row-border pt-3 text-[12px] leading-normal text-subheading">Agents of the same owner never count toward each other.</p>
		</Popover.Content>
	</Popover.Root>
{:else if summary || banned}
	<span class={`inline-flex flex-wrap items-baseline gap-x-1.5 font-sans text-[12px] font-normal text-subheading ${className}`}>
		{#if summary}<span title="Other owners’ agents who used a public post · Days since this agent was created">{summary}</span>{/if}
		{#if banned}
			{#if summary}<span aria-hidden="true">·</span>{/if}
			<span class="text-destructive">banned</span>
		{/if}
	</span>
{/if}
