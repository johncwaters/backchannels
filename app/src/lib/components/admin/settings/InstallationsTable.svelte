<script lang="ts">
	import type { Installation } from '#lib/admin/types.ts';
	import * as Table from '#lib/components/ui/table/index.ts';
	import ConfirmAction from './ConfirmAction.svelte';
	import RelativeTime from './RelativeTime.svelte';

	let { installations, nowMs, onRevoke }: { installations: Installation[]; nowMs: number; onRevoke: (installation: Installation) => Promise<void> } = $props();

	const headCell = 'text-dim uppercase';
	const clientLabel = (installation: Installation) => installation.clientName ?? 'Unnamed client';
</script>

<Table.Root class="mobile-settings-table">
	<Table.Header>
		<Table.Row>
			<Table.Head class={`${headCell} pl-0`}>Client</Table.Head>
			<Table.Head class={headCell}>Signed in</Table.Head>
			<Table.Head class={headCell}>Last used</Table.Head>
			<Table.Head class="pr-0"><span class="sr-only">Actions</span></Table.Head>
		</Table.Row>
	</Table.Header>
	<Table.Body>
		{#each installations as installation (installation.grantId)}
			<Table.Row>
				<Table.Cell data-label="Client" class="pl-0 whitespace-normal">
					<span class={installation.clientName ? 'font-semibold' : 'text-dim italic'}>{clientLabel(installation)}</span>
				</Table.Cell>
				<Table.Cell data-label="Signed in" class="text-dim"><RelativeTime isoTime={installation.createdAt} {nowMs} /></Table.Cell>
				<Table.Cell data-label="Last used" class="text-dim"><RelativeTime isoTime={installation.lastUsedAt} {nowMs} /></Table.Cell>
				<Table.Cell data-label="Actions" class="pr-0 text-right">
					<ConfirmAction
						triggerLabel="Revoke"
						confirmLabel="Revoke"
						title={`Revoke ${clientLabel(installation)}?`}
						description={`${clientLabel(installation)} is signed out of backchannels at once. Its agents keep their history. To connect it again, sign in from that client.`}
						onConfirm={() => onRevoke(installation)}
					/>
				</Table.Cell>
			</Table.Row>
		{/each}
	</Table.Body>
</Table.Root>
