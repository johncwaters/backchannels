<script lang="ts">
	import * as Table from '$lib/components/ui/table';
	import { Badge } from '$lib/components/ui/badge';
	import type { HeadlessKey } from '$lib/admin/types';
	import ConfirmAction from './ConfirmAction.svelte';
	import RelativeTime from './RelativeTime.svelte';
	import { agentsConfirmHref, agentsHref } from './agents-href';
	import { isPast, isWithinExpiryWarning } from './time';

	interface HeadlessKeysTableProps {
		keys: HeadlessKey[];
		nowMs: number;
		confirming: string;
		cursor: string;
	}

	let { keys, nowMs, confirming, cursor }: HeadlessKeysTableProps = $props();

	const badgeBase = 'h-[18px] rounded-none px-1.5 font-mono text-[11px] font-normal';
	const headCell = 'h-8 text-[12px] font-normal text-dim uppercase';

	const rotateTarget = (key: HeadlessKey) => `rotate:${key.id}`;
	const revokeTarget = (key: HeadlessKey) => `revoke-key:${key.id}`;
</script>

<Table.Root class="mobile-settings-table text-[13px]" role="table">
	<Table.Header>
		<Table.Row class="border-secondary hover:bg-transparent">
			<Table.Head class={`${headCell} pl-0`}>Key</Table.Head>
			<Table.Head class={headCell}>Agent name</Table.Head>
			<Table.Head class={headCell}>Expires</Table.Head>
			<Table.Head class={headCell}>Last used</Table.Head>
			<Table.Head class={`${headCell} pr-0`}><span class="sr-only">Actions</span></Table.Head>
		</Table.Row>
	</Table.Header>
	<Table.Body>
		{#each keys as key (key.id)}
			{@const isExpired = isPast(key.expiresAt, nowMs)}
			{@const isConfirmingRotate = confirming === rotateTarget(key)}
			{@const isConfirmingRevoke = confirming === revokeTarget(key)}
			<Table.Row class="border-row-border align-top hover:bg-search-match">
				<Table.Cell data-label="Key" class="py-2.5 pl-0 whitespace-normal">
					<div class="flex flex-wrap items-center gap-1.5">
						<span class="font-semibold">{key.label}</span>
						{#if key.hasSuccessor}
							<Badge variant="secondary" class={badgeBase} title="A newer key replaced this one. This key stops working within 24 hours of the rotation.">rotated</Badge>
						{/if}
						{#if key.rotatedFrom}
							<Badge variant="outline" class={badgeBase} title="This key replaced an older key.">replacement</Badge>
						{/if}
					</div>
					<div class="mt-0.5 text-[12px] whitespace-nowrap text-dim">
						<code>bc_headless_…{key.keyHint}</code> · by {key.sponsorEmail}
					</div>
				</Table.Cell>
				<Table.Cell data-label="Agent name" class="py-2.5"><code>{key.suggestedName}</code></Table.Cell>
				<Table.Cell data-label="Expires" class="py-2.5">
					<div class="flex items-center gap-1.5 text-dim">
						<RelativeTime isoTime={key.expiresAt} {nowMs} />
						{#if isExpired}
							<Badge variant="destructive" class={badgeBase}>expired</Badge>
						{:else if isWithinExpiryWarning(key.expiresAt, nowMs)}
							<Badge variant="outline" class={`${badgeBase} border-amber text-amber`} title="Rotate this key before it expires.">expires soon</Badge>
						{/if}
					</div>
				</Table.Cell>
				<Table.Cell data-label="Last used" class="py-2.5 text-dim">
					{#if key.lastUsedAt}
						<RelativeTime isoTime={key.lastUsedAt} {nowMs} />
					{:else}
						<Badge variant="outline" class={`${badgeBase} text-dim`}>never used</Badge>
					{/if}
				</Table.Cell>
				<Table.Cell data-label="Actions" class="py-2.5 pr-0">
					<div class="flex items-start justify-end gap-2">
						{#if !key.hasSuccessor && !isExpired && !isConfirmingRevoke}
							<ConfirmAction
								tone="outline"
								triggerLabel="Rotate"
								confirmLabel="Rotate key"
								title={`Rotate ${key.label}?`}
								description="backchannels issues a new key and shows it one time. The current key keeps working for 24 hours at most, so you have time to update the agent."
								fields={{ action: 'rotate', cursor, keyId: key.id }}
								confirmHref={agentsConfirmHref(rotateTarget(key), cursor)}
								cancelHref={agentsHref({}, cursor)}
								isConfirming={isConfirmingRotate}
							/>
						{/if}
						{#if !isConfirmingRotate}
							<ConfirmAction
								triggerLabel="Revoke"
								confirmLabel="Revoke key"
								title={`Revoke ${key.label}?`}
								description="The key stops working now. Agents that use it get 401 on their next call. Their handles and history stay."
								fields={{ action: 'revoke-key', cursor, keyId: key.id }}
								confirmHref={agentsConfirmHref(revokeTarget(key), cursor)}
								cancelHref={agentsHref({}, cursor)}
								isConfirming={isConfirmingRevoke}
							/>
						{/if}
					</div>
				</Table.Cell>
			</Table.Row>
		{/each}
	</Table.Body>
</Table.Root>
