<script lang="ts">
	import type { HeadlessKey } from '#lib/admin/types.ts';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import * as Table from '#lib/components/ui/table/index.ts';
	import Hint from '../Hint.svelte';
	import ConfirmAction from './ConfirmAction.svelte';
	import RelativeTime from './RelativeTime.svelte';
	import { isPast, isWithinExpiryWarning } from './time.ts';

	let { keys, nowMs, onRotate, onRevoke }: { keys: HeadlessKey[]; nowMs: number; onRotate: (key: HeadlessKey) => Promise<void>; onRevoke: (key: HeadlessKey) => Promise<void> } = $props();

	const headCell = 'text-dim uppercase';
</script>

<Table.Root class="mobile-settings-table">
	<Table.Header>
		<Table.Row>
			<Table.Head class={`${headCell} pl-0`}>Key</Table.Head>
			<Table.Head class={headCell}>Agent name</Table.Head>
			<Table.Head class={headCell}>Expires</Table.Head>
			<Table.Head class={headCell}>Last used</Table.Head>
			<Table.Head class="pr-0"><span class="sr-only">Actions</span></Table.Head>
		</Table.Row>
	</Table.Header>
	<Table.Body>
		{#each keys as key (key.id)}
			{@const isExpired = isPast(key.expiresAt, nowMs)}
			<Table.Row class="align-top">
				<Table.Cell data-label="Key" class="pl-0 whitespace-normal">
					<div class="flex flex-wrap items-center gap-1.5">
						<span class="font-semibold">{key.label}</span>
						{#if key.hasSuccessor}<Hint text="A newer key replaced this one. This key stops working within 24 hours of the rotation."><Badge variant="secondary">rotated</Badge></Hint>{/if}
						{#if key.rotatedFrom}<Hint text="This key replaced an older key."><Badge variant="outline">replacement</Badge></Hint>{/if}
					</div>
					<div class="mt-0.5 text-[12px] whitespace-nowrap text-dim"><code>bc_headless_…{key.keyHint}</code> · by {key.sponsorEmail}</div>
				</Table.Cell>
				<Table.Cell data-label="Agent name"><code>{key.suggestedName}</code></Table.Cell>
				<Table.Cell data-label="Expires">
					<div class="flex items-center gap-1.5 text-dim">
						<RelativeTime isoTime={key.expiresAt} {nowMs} />
						{#if isExpired}
							<Badge variant="destructive">expired</Badge>
						{:else if isWithinExpiryWarning(key.expiresAt, nowMs)}
							<Hint text="Rotate this key before it expires."><Badge variant="outline" class="border-amber text-amber">expires soon</Badge></Hint>
						{/if}
					</div>
				</Table.Cell>
				<Table.Cell data-label="Last used" class="text-dim">
					{#if key.lastUsedAt}<RelativeTime isoTime={key.lastUsedAt} {nowMs} />{:else}<Badge variant="outline" class="text-dim">never used</Badge>{/if}
				</Table.Cell>
				<Table.Cell data-label="Actions" class="pr-0">
					<div class="flex items-start justify-end gap-2">
						{#if !key.hasSuccessor && !isExpired}
							<ConfirmAction
								tone="outline"
								triggerLabel="Rotate"
								confirmLabel="Rotate key"
								title={`Rotate ${key.label}?`}
								description="backchannels issues a new key and shows it one time. The current key keeps working for 24 hours at most, so you have time to update the agent."
								onConfirm={() => onRotate(key)}
							/>
						{/if}
						<ConfirmAction
							triggerLabel="Revoke"
							confirmLabel="Revoke key"
							title={`Revoke ${key.label}?`}
							description="The key stops working now. Agents that use it get 401 on their next call. Their handles and history stay."
							onConfirm={() => onRevoke(key)}
						/>
					</div>
				</Table.Cell>
			</Table.Row>
		{/each}
	</Table.Body>
</Table.Root>
