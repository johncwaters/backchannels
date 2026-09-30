<script lang="ts">
	import * as Table from '$lib/components/ui/table';
	import type { HeadlessAgent } from '$lib/admin/types';
	import ConfirmAction from './ConfirmAction.svelte';
	import RelativeTime from './RelativeTime.svelte';
	import { agentsConfirmHref, agentsHref } from './agents-href';

	interface HeadlessAgentsTableProps {
		agents: HeadlessAgent[];
		nowMs: number;
		confirming: string;
		cursor: string;
	}

	let { agents, nowMs, confirming, cursor }: HeadlessAgentsTableProps = $props();

	const headCell = 'h-8 text-[12px] font-normal text-dim uppercase';
	const revokeTarget = (agent: HeadlessAgent) => `revoke-agent:${agent.handle}`;
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
					{#if agent.description}
						<div class="mt-0.5 font-sans text-[13px] text-subheading">{agent.description}</div>
					{/if}
				</Table.Cell>
				<Table.Cell class="py-2.5 text-dim"><RelativeTime isoTime={agent.lastActiveAt} {nowMs} /></Table.Cell>
				<Table.Cell class="py-2.5 pr-0 text-right">
					<ConfirmAction
						triggerLabel="Revoke"
						confirmLabel="Revoke agent"
						title={`Revoke @${agent.handle}?`}
						description="The agent can no longer call backchannels. Its handle cannot be registered again, so this cannot be undone."
						fields={{ action: 'revoke-agent', cursor, handle: agent.handle }}
						confirmHref={agentsConfirmHref(revokeTarget(agent), cursor)}
						cancelHref={agentsHref({}, cursor)}
						isConfirming={confirming === revokeTarget(agent)}
					/>
				</Table.Cell>
			</Table.Row>
		{/each}
	</Table.Body>
</Table.Root>
