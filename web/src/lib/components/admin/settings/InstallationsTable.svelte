<script lang="ts">
	import * as Table from '$lib/components/ui/table';
	import type { Installation } from '$lib/admin/types';
	import ConfirmAction from './ConfirmAction.svelte';
	import RelativeTime from './RelativeTime.svelte';

	let { installations, nowMs, confirmingGrantId = '' }: { installations: Installation[]; nowMs: number; confirmingGrantId?: string } = $props();

	const clientLabel = (installation: Installation) => installation.clientName ?? 'Unnamed client';
	const confirmHref = (grantId: string) => `/admin/installations?confirm=${encodeURIComponent(grantId)}`;
</script>

<Table.Root class="text-[13px]">
	<Table.Header>
		<Table.Row class="border-secondary hover:bg-transparent">
			<Table.Head class="h-8 pl-0 text-[12px] font-normal text-dim uppercase">Client</Table.Head>
			<Table.Head class="h-8 text-[12px] font-normal text-dim uppercase">Signed in</Table.Head>
			<Table.Head class="h-8 text-[12px] font-normal text-dim uppercase">Last used</Table.Head>
			<Table.Head class="h-8 pr-0 text-right text-[12px] font-normal text-dim uppercase"><span class="sr-only">Actions</span></Table.Head>
		</Table.Row>
	</Table.Header>
	<Table.Body>
		{#each installations as installation (installation.grantId)}
			<Table.Row class="border-row-border hover:bg-search-match">
				<Table.Cell class="py-2.5 pl-0 whitespace-normal">
					<span class={installation.clientName ? 'font-semibold' : 'text-dim italic'}>{clientLabel(installation)}</span>
				</Table.Cell>
				<Table.Cell class="py-2.5 text-dim"><RelativeTime isoTime={installation.createdAt} {nowMs} /></Table.Cell>
				<Table.Cell class="py-2.5 text-dim"><RelativeTime isoTime={installation.lastUsedAt} {nowMs} /></Table.Cell>
				<Table.Cell class="py-2.5 pr-0 text-right">
					<ConfirmAction
						triggerLabel="Revoke"
						confirmLabel="Revoke"
						title={`Revoke ${clientLabel(installation)}?`}
						description={`${clientLabel(installation)} is signed out of backchannels at once. Its agents keep their history. To connect it again, sign in from that client.`}
						fields={{ grantId: installation.grantId }}
						confirmHref={confirmHref(installation.grantId)}
						cancelHref="/admin/installations"
						isConfirming={confirmingGrantId === installation.grantId}
					/>
				</Table.Cell>
			</Table.Row>
		{/each}
	</Table.Body>
</Table.Root>
