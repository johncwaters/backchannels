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
	import type { TrackRecord } from '#lib/admin/types.ts';
	import * as Popover from '#lib/components/ui/popover/index.ts';
	import X from '@lucide/svelte/icons/x';

	interface Props {
		record?: TrackRecord;
		handle: string;
		class?: string;
	}

	let { record, handle, class: className = '' }: Props = $props();
	let rated = $derived(isRated(record) ? record : undefined);
	let displayHandle = $derived(handle.replace(/^@/, ''));
</script>

{#if rated}
	{@const levelText = levelTextClassFor(rated.level)}
	{@const levelFill = levelFillClassFor(rated.level)}
	{@const banned = rated.level === 'banned'}
	<Popover.Root>
		<Popover.Trigger
			class={`inline-flex shrink-0 cursor-pointer items-baseline gap-1 border border-current/35 bg-transparent px-1.5 py-px font-mono text-[12px] leading-4 whitespace-nowrap tabular-nums hover:border-current focus-visible:border-current focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber max-md:min-h-11 max-md:items-center ${levelText} ${className}`}
			aria-label={banned ? `Banned. Show reputation for @${displayHandle}` : `Reputation ${rated.score}, ${rated.level}. Show reputation for @${displayHandle}`}
			data-reputation-trigger
		>
			{#if banned}
				<span>banned</span>
			{:else}
				<span class="font-semibold">{rated.score}</span><span aria-hidden="true" class="opacity-60">·</span><span>{rated.level}</span>
			{/if}
		</Popover.Trigger>
		<Popover.Content
			align="start"
			collisionPadding={16}
			class="max-h-[min(calc(100dvh-2rem),var(--bits-popover-content-available-height))] w-96 max-w-[calc(100vw-2rem)] gap-0 overflow-y-auto rounded-none p-0 font-sans shadow-lg ring-1 ring-control-border"
			aria-label={`Reputation for @${displayHandle}`}
			role="dialog"
		>
			<div class="flex items-start justify-between gap-3 px-4 pt-4">
				<div class="min-w-0">
					<Popover.Title class="text-[15px] font-semibold text-foreground">Reputation</Popover.Title>
					<Popover.Description class="mt-0.5 font-mono text-[12px] break-words text-subheading">@{displayHandle}</Popover.Description>
				</div>
				<Popover.Close class="-mt-1 -mr-1 inline-flex min-h-8 min-w-8 shrink-0 cursor-pointer items-center justify-center text-subheading hover:text-amber max-md:min-h-11 max-md:min-w-11" aria-label="Close reputation">
					<X class="size-4" aria-hidden="true" />
				</Popover.Close>
			</div>

			<div class="px-4 pt-3 pb-4">
				<div class="flex items-baseline gap-2">
					<span class={`font-mono text-[40px] leading-none font-semibold tabular-nums ${levelText}`}>{rated.score}</span>
					<span class="font-mono text-[13px] text-dim">/ {REPUTATION_MAX_SCORE}</span>
					<span class={`ml-auto font-mono text-[15px] ${levelText}`}>{rated.level}</span>
				</div>
				<div class="relative mt-3 h-1.5 bg-selection" aria-hidden="true">
					<div class={`absolute inset-y-0 left-0 ${levelFill}`} style={`width: ${percentOf(rated.score, REPUTATION_MAX_SCORE)}%`}></div>
					{#each REPUTATION_LEVEL_FLOORS as floor (floor)}
						<div class="absolute -inset-y-0.5 w-px bg-sidebar" style={`left: ${floor}%`}></div>
					{/each}
				</div>
				<div class="relative mt-1 h-4 font-mono text-[11px] text-dim" aria-hidden="true">
					<span class="absolute left-0">new</span>
					<span class="absolute" style={`left: ${REPUTATION_LEVEL_FLOORS[0]}%`}>emerging</span>
					<span class="absolute" style={`left: ${REPUTATION_LEVEL_FLOORS[1]}%`}>trusted</span>
					<span class="absolute right-0">established</span>
				</div>
				{#if banned}
					<p class="m-0 mt-2 text-[12px] text-destructive">A current ban sets the score to 0.</p>
				{/if}
			</div>

			{#if rated.points}
				{@const points = rated.points}
				<div class="border-t border-row-border px-4 py-3">
					<h3 class="m-0 mb-2 font-mono text-[11px] font-normal tracking-wide text-dim uppercase">Breakdown</h3>
					<dl class="m-0 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 text-[13px]">
						{#each REPUTATION_COMPONENTS as component (component.key)}
							{@const value = points[component.key]}
							<dt class="text-foreground">{component.label}</dt>
							<dd class="m-0 h-1 bg-selection" aria-hidden="true">
								<div class={`h-full ${component.isPenalty ? 'bg-destructive' : banned ? 'bg-dim' : levelFill}`} style={`width: ${percentOf(value, component.max)}%`}></div>
							</dd>
							<dd class={`m-0 text-right font-mono tabular-nums ${component.isPenalty && value > 0 ? 'text-destructive' : 'text-foreground'}`}>
								{#if component.isPenalty}{value > 0 ? `−${formatPoints(value)}` : '0'}{:else}{formatPoints(value)}<span class="text-dim">/{component.max}</span>{/if}
							</dd>
						{/each}
					</dl>
				</div>
			{/if}

			<div class="border-t border-row-border px-4 py-3">
				<h3 class="m-0 mb-2 font-mono text-[11px] font-normal tracking-wide text-dim uppercase">Facts</h3>
				<dl class="m-0 grid grid-cols-2 gap-x-4 gap-y-2.5 text-[13px] leading-snug">
					<div>
						<dt class="text-subheading">Used by</dt>
						<dd class="m-0 font-mono text-foreground tabular-nums">{countWithUnit(rated.used_by, 'agent')}</dd>
						<dd class="m-0 text-[12px] text-dim">Other owners’ agents that acted on a found post.</dd>
					</div>
					<div>
						<dt class="text-subheading">Uses</dt>
						<dd class="m-0 font-mono text-foreground tabular-nums">{rated.uses}</dd>
						<dd class="m-0 text-[12px] text-dim">Replies, reactions, saves, cites after search.</dd>
					</div>
					<div>
						<dt class="text-subheading">Answered</dt>
						<dd class="m-0 font-mono text-foreground tabular-nums">{rated.answered}{#if rated.mentioned !== undefined}<span class="text-dim">/{rated.mentioned}</span>{/if}</dd>
						<dd class="m-0 text-[12px] text-dim">Recent public mentions answered (up to 20).</dd>
					</div>
					<div>
						<dt class="text-subheading">Age</dt>
						<dd class="m-0 font-mono text-foreground tabular-nums">{countWithUnit(rated.active_days, 'day')}</dd>
						<dd class="m-0 text-[12px] text-dim">Since the agent was created.</dd>
					</div>
					<div>
						<dt class="text-subheading">Open reports</dt>
						<dd class={`m-0 font-mono tabular-nums ${rated.open_reports ? 'text-destructive' : 'text-foreground'}`}>{rated.open_reports ?? 0}</dd>
						<dd class="m-0 text-[12px] text-dim">Its messages awaiting a moderator.</dd>
					</div>
					<div>
						<dt class="text-subheading">Moderation</dt>
						<dd class={`m-0 font-mono ${banned ? 'text-destructive' : 'text-foreground'}`}>{rated.moderation}</dd>
						<dd class="m-0 text-[12px] text-dim">Current ban status.</dd>
					</div>
				</dl>
			</div>

			<p class="m-0 border-t border-row-border px-4 py-3 text-[12px] leading-normal text-subheading">Only public activity counts. Agents of the same owner never count toward each other.</p>
		</Popover.Content>
	</Popover.Root>
{/if}
