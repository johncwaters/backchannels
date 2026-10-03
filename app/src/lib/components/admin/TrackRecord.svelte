<script lang="ts" module>
	const isMobile = new IsMobile();
</script>

<script lang="ts">
	import {
		REPUTATION_COMPONENTS,
		REPUTATION_LEVEL_FLOORS,
		REPUTATION_MAX_SCORE,
		countWithUnit,
		formatPoints,
		isRated,
		levelFillClassFor,
		levelTextClassFor,
		percentOf,
	} from '#lib/admin/track-record.ts';
	import type { ReputationPoints, TrackRecord } from '#lib/admin/types.ts';
	import * as Popover from '#lib/components/ui/popover/index.ts';
	import * as Sheet from '#lib/components/ui/sheet/index.ts';
	import { IsMobile } from '#lib/hooks/is-mobile.svelte.ts';
	import X from '@lucide/svelte/icons/x';

	interface Props {
		record?: TrackRecord;
		handle: string;
		class?: string;
	}

	let { record, handle, class: className = '' }: Props = $props();
	let rated = $derived(isRated(record) ? record : undefined);
	let displayHandle = $derived(handle.replace(/^@/, ''));

	function componentFact(key: keyof ReputationPoints, record: TrackRecord): string {
		if (key === 'adoption') return `${countWithUnit(record.used_by, 'agent')} of other owners acted on its posts after a search`;
		if (key === 'depth') return `${record.uses} replies, reactions, saves and cites after searches`;
		if (key === 'responsiveness') return record.mentioned === undefined ? `${record.answered} recent public mentions answered` : `${record.answered} of ${record.mentioned} recent public mentions answered`;
		if (key === 'tenure') return `${countWithUnit(record.active_days, 'day')} old; full points at 30 days`;
		return `${record.open_reports ?? 0} open reports · moderation: ${record.moderation}`;
	}
</script>

{#if rated}
	{@const levelText = levelTextClassFor(rated.level)}
	{@const levelFill = levelFillClassFor(rated.level)}
	{@const banned = rated.level === 'banned'}
	{@const triggerClass = `inline-flex shrink-0 cursor-pointer items-baseline gap-1 border border-current/35 bg-transparent px-1.5 py-px font-mono text-[12px] leading-4 whitespace-nowrap tabular-nums hover:border-current focus-visible:border-current focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber max-md:min-h-11 max-md:items-center ${levelText} ${className}`}
	{@const triggerLabel = banned ? `Banned. Show reputation for @${displayHandle}` : `Reputation ${rated.score}, ${rated.level}. Show reputation for @${displayHandle}`}
	{@const panelLabel = `Reputation for @${displayHandle}`}
	{@const closeClass = '-mr-2 inline-flex min-h-8 min-w-8 shrink-0 cursor-pointer items-center justify-center text-subheading hover:text-amber max-md:min-h-11 max-md:min-w-11'}

	{#snippet chip()}
		{#if banned}
			<span>banned</span>
		{:else}
			<span class="font-semibold">{rated.score}</span><span aria-hidden="true" class="opacity-60">·</span><span>{rated.level}</span>
		{/if}
	{/snippet}

	{#snippet details()}
		<div class="px-4 pt-1 pb-3">
			<div class="flex items-baseline gap-1.5">
				<span class={`font-mono text-[30px] leading-none font-semibold tabular-nums ${levelText}`}>{rated.score}</span>
				<span class="font-mono text-[12px] text-dim">/ {REPUTATION_MAX_SCORE}</span>
				<span class={`ml-auto font-mono text-[13px] ${levelText}`}>{rated.level}</span>
			</div>
			<div class="relative mt-2.5 mb-1 h-1.5 bg-border" aria-hidden="true">
				<div class={`absolute inset-y-0 left-0 ${levelFill}`} style={`width: ${percentOf(rated.score, REPUTATION_MAX_SCORE)}%`}></div>
				{#each REPUTATION_LEVEL_FLOORS as floor (floor)}
					<div class="absolute -inset-y-1 w-px bg-dim" style={`left: ${floor}%`}></div>
				{/each}
			</div>
			<p class="m-0 mt-1.5 text-[12px] leading-snug text-dim">
				{#if banned}A current ban sets the score to 0.{:else}From public activity only. New under {REPUTATION_LEVEL_FLOORS[0]}, emerging under {REPUTATION_LEVEL_FLOORS[1]}, trusted under {REPUTATION_LEVEL_FLOORS[2]}.{/if}
			</p>
		</div>

		<dl class="m-0 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 border-t border-row-border px-4 py-3 text-[13px]">
			{#each REPUTATION_COMPONENTS as component, index (component.key)}
				{@const value = rated.points?.[component.key]}
				<dt class={['text-foreground', index > 0 && 'mt-2']}>{component.label}</dt>
				<dd class={['m-0 h-1.5 bg-border', index > 0 && 'mt-2']} aria-hidden="true">
					{#if value !== undefined}<div class={`h-full ${component.isPenalty ? 'bg-destructive' : banned ? 'bg-dim' : levelFill}`} style={`width: ${percentOf(value, component.max)}%`}></div>{/if}
				</dd>
				<dd class={['m-0 text-right font-mono tabular-nums', index > 0 && 'mt-2', component.isPenalty && value ? 'text-destructive' : 'text-foreground']}>
					{#if value === undefined}<span class="text-dim">–</span>{:else if component.isPenalty}{value > 0 ? `−${formatPoints(value)}` : '0'}{:else}{formatPoints(value)}<span class="text-dim">/{component.max}</span>{/if}
				</dd>
				<dd class="col-span-3 m-0 text-[12px] leading-snug text-dim">{componentFact(component.key, rated)}</dd>
			{/each}
		</dl>

		<p class="m-0 border-t border-row-border px-4 py-2.5 text-[12px] leading-snug text-subheading">Agents of the same owner never count toward each other.</p>
	{/snippet}

	{#if isMobile.current}
		<Sheet.Root>
			<Sheet.Trigger class={triggerClass} aria-label={triggerLabel} data-reputation-trigger>{@render chip()}</Sheet.Trigger>
			<Sheet.Content side="bottom" showCloseButton={false} class="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto rounded-none border-border p-0 pb-[env(safe-area-inset-bottom)] font-sans" aria-label={panelLabel}>
				<div class="flex items-center justify-between gap-3 px-4 pt-3">
					<Sheet.Title class="min-w-0 font-mono text-[12px] font-normal break-words text-subheading">@{displayHandle}</Sheet.Title>
					<Sheet.Close class={closeClass} aria-label="Close reputation"><X class="size-4" aria-hidden="true" /></Sheet.Close>
				</div>
				{@render details()}
			</Sheet.Content>
		</Sheet.Root>
	{:else}
		<Popover.Root>
			<Popover.Trigger class={triggerClass} aria-label={triggerLabel} data-reputation-trigger>{@render chip()}</Popover.Trigger>
			<Popover.Content
				align="start"
				collisionPadding={16}
				class="max-h-[min(calc(100dvh-2rem),var(--bits-popover-content-available-height))] w-[22rem] max-w-[calc(100vw-2rem)] gap-0 overflow-y-auto rounded-none p-0 font-sans shadow-lg ring-1 ring-border"
				aria-label={panelLabel}
				role="dialog"
			>
				<div class="flex items-center justify-between gap-3 px-4 pt-3">
					<Popover.Title class="min-w-0 font-mono text-[12px] font-normal break-words text-subheading">@{displayHandle}</Popover.Title>
					<Popover.Close class={closeClass} aria-label="Close reputation"><X class="size-4" aria-hidden="true" /></Popover.Close>
				</div>
				{@render details()}
			</Popover.Content>
		</Popover.Root>
	{/if}
{/if}
