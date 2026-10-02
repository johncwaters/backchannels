<script lang="ts">
	import * as Table from '#lib/components/ui/table/index.ts';
	import type { AgentSummary } from '#lib/admin/types.ts';
	import ConfirmAction from './ConfirmAction.svelte';
	import RelativeTime from './RelativeTime.svelte';
	import TrackRecord from '../TrackRecord.svelte';

	interface AgentsTableProps {
		agents: AgentSummary[];
		nowMs: number;
		confirming: string;
		cancelHref: string;
		triggerLabel: string;
		revokeDescription: string;
		extraFields?: Record<string, string>;
	}

	let { agents, nowMs, confirming, cancelHref, triggerLabel, revokeDescription, extraFields = {} }: AgentsTableProps = $props();

	const headCell = 'h-8 text-[12px] font-normal text-dim uppercase';
	const revokeTarget = (agent: AgentSummary) => `revoke-agent:${agent.handle}`;

	function confirmHref(agent: AgentSummary): string {
		const [path, query = ''] = cancelHref.split('?');
		const params = new URLSearchParams(query);
		params.set('confirm', revokeTarget(agent));
		return `${path}?${params}`;
	}
</script>

<Table.Root class="text-[13px]">
	<Table.Header>
		<Table.Row class="border-secondary hover:bg-transparent">
			<Table.Head class={`${headCell} pl-0`}>Agent</Table.Head>
			<Table.Head class={headCell}>Last active</Table.Head>
			<Table.Head class={`${headCell} pr-0`}><span class="sr-only">Actions</span></Table.Head>
		</Table.Row>
	</Table.Header>
	<Table.Body>
		{#each agents as agent (agent.handle)}
			<Table.Row class="border-row-border align-top hover:bg-search-match">
				<Table.Cell class="py-2.5 pl-0 whitespace-normal">
					<div class="font-semibold">@{agent.handle}</div>
					<TrackRecord record={agent.track_record} handle={agent.handle} interactive class="mt-0.5" />
					{#if agent.description}
						<div class="mt-0.5 font-sans text-[13px] text-subheading">{agent.description}</div>
					{/if}
				</Table.Cell>
				<Table.Cell class="py-2.5 text-dim"><RelativeTime isoTime={agent.lastActiveAt} {nowMs} /></Table.Cell>
				<Table.Cell class="py-2.5 pr-0 text-right">
					<ConfirmAction
						{triggerLabel}
						confirmLabel="Revoke agent"
						title={`Revoke @${agent.handle}?`}
						description={revokeDescription}
						fields={{ ...extraFields, action: 'revoke-agent', handle: agent.handle }}
						confirmHref={confirmHref(agent)}
						{cancelHref}
						isConfirming={confirming === revokeTarget(agent)}
					/>
				</Table.Cell>
			</Table.Row>
		{/each}
	</Table.Body>
</Table.Root>
