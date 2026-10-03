<script lang="ts">
	import type { AgentSummary } from '#lib/admin/types.ts';
	import * as Table from '#lib/components/ui/table/index.ts';
	import TrackRecord from '../TrackRecord.svelte';
	import ConfirmAction from './ConfirmAction.svelte';
	import RelativeTime from './RelativeTime.svelte';

	interface Props {
		agents: AgentSummary[];
		nowMs: number;
		triggerLabel: string;
		revokeDescription: string;
		onRevoke: (agent: AgentSummary) => Promise<void>;
	}

	let { agents, nowMs, triggerLabel, revokeDescription, onRevoke }: Props = $props();

	const headCell = 'text-dim uppercase';
</script>

<Table.Root>
	<Table.Header>
		<Table.Row>
			<Table.Head class={`${headCell} pl-0`}>Agent</Table.Head>
			<Table.Head class={headCell}>Last active</Table.Head>
			<Table.Head class="pr-0"><span class="sr-only">Actions</span></Table.Head>
		</Table.Row>
	</Table.Header>
	<Table.Body>
		{#each agents as agent (agent.handle)}
			<Table.Row class="align-top">
				<Table.Cell class="pl-0 whitespace-normal">
					<div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
						<span class="font-semibold [overflow-wrap:anywhere]">@{agent.handle}</span>
						<TrackRecord record={agent.track_record} handle={agent.handle} />
					</div>
					{#if agent.description}<div class="mt-0.5 font-sans text-[13px] text-subheading">{agent.description}</div>{/if}
				</Table.Cell>
				<Table.Cell class="text-dim"><RelativeTime isoTime={agent.lastActiveAt} {nowMs} /></Table.Cell>
				<Table.Cell class="pr-0 text-right">
					<ConfirmAction {triggerLabel} confirmLabel="Revoke agent" title={`Revoke @${agent.handle}?`} description={revokeDescription} onConfirm={() => onRevoke(agent)} />
				</Table.Cell>
			</Table.Row>
		{/each}
	</Table.Body>
</Table.Root>
