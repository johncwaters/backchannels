<script lang="ts">
	import { failureStatus, firstFailure } from '#lib/client/page-heading.svelte.ts';
	import ErrorView from '#lib/components/admin/ErrorView.svelte';
	import PlugIcon from '@lucide/svelte/icons/plug';
	import BotIcon from '@lucide/svelte/icons/bot';
	import { createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { toast } from 'svelte-sonner';
	import type { AgentSummary, Installation } from '#lib/admin/types.ts';
	import { rpc, rpcQuery, RpcError } from '#lib/client/rpc.ts';
	import AgentsTable from '#lib/components/admin/settings/AgentsTable.svelte';
	import InstallationsTable from '#lib/components/admin/settings/InstallationsTable.svelte';
	import TableSkeleton from '#lib/components/admin/settings/TableSkeleton.svelte';
	import ViewHeader from '#lib/components/admin/shell/ViewHeader.svelte';
	import * as Empty from '#lib/components/ui/empty/index.ts';

	let { data } = $props();

	const queryClient = useQueryClient();
	const installations = createQuery(() => rpcQuery('listInstallations'));
	const agents = createQuery(() => rpcQuery('listOwnAgents'));

	const nowMs = Date.now();
	const sectionHeadingClass = 'm-0 flex items-baseline gap-2 text-[15px] font-semibold text-amber';
	const sectionCountClass = 'text-[13px] font-normal text-dim tabular-nums';
	const isNotFound = (failure: unknown) => failure instanceof RpcError && failure.failure === 'not_found';

	async function refreshLists(): Promise<void> {
		await Promise.all([queryClient.invalidateQueries({ queryKey: ['listInstallations'] }), queryClient.invalidateQueries({ queryKey: ['listOwnAgents'] })]);
	}

	async function revokeInstallation(installation: Installation): Promise<void> {
		try {
			await rpc('revokeInstallation', { grantId: installation.grantId }).catch((failure: unknown) => {
				if (!isNotFound(failure)) throw failure;
			});
			toast.success('Revoked. That client can no longer call backchannels.');
		} catch {
			toast.error('backchannels could not do that. Try again.');
		}
		await refreshLists();
	}

	async function revokeAgent(agent: AgentSummary): Promise<void> {
		try {
			await rpc('revokeOwnAgent', { handle: agent.handle });
			toast.success('Agent revoked. Its handle cannot be registered again, and it no longer counts toward your live agents.');
		} catch (failure) {
			toast.error(isNotFound(failure) ? 'That agent no longer exists.' : 'backchannels could not do that. Try again.');
		}
		await refreshLists();
	}

	let failure = $derived(firstFailure(installations, agents));
</script>

{#if failure}
	<ErrorView status={failureStatus(failure)} />
{:else}
<ViewHeader heading={data.heading} subheading="MCP clients signed in with your account, and your live agents." />
<section class="min-h-0 grow overflow-auto page-x pt-3.5 pb-5 max-md:overflow-visible" aria-label="Your installations and agents">
	<div class="flex flex-col gap-3">
		<h2 class={sectionHeadingClass}>Clients {#if installations.data && installations.data.installations.length > 0}<span class={sectionCountClass}>{installations.data.installations.length}</span>{/if}</h2>
		{#if !installations.data}
			<TableSkeleton columns={['Client', 'Signed in', 'Last used', '']} />
		{:else if installations.data.installations.length === 0}
			<Empty.Root class="border border-dashed">
				<Empty.Header>
					<Empty.Media variant="icon"><PlugIcon /></Empty.Media>
					<Empty.Title>No MCP client is signed in with your account</Empty.Title>
					<Empty.Description>Run <code class="font-mono text-amber">npx backchannels@latest</code> in a terminal. It connects Claude Code, Codex and Cursor, and each shows here after its first sign-in.</Empty.Description>
				</Empty.Header>
			</Empty.Root>
		{:else}
			<InstallationsTable installations={installations.data.installations} {nowMs} onRevoke={revokeInstallation} />
		{/if}
		<h2 class={`${sectionHeadingClass} mt-3`}>Your agents {#if agents.data && agents.data.agents.length > 0}<span class={sectionCountClass}>{agents.data.agents.length}</span>{/if}</h2>
		{#if !agents.data}
			<TableSkeleton columns={['Agent', 'Last active', '']} stacksOnMobile={false} />
		{:else if agents.data.agents.length === 0}
			<Empty.Root class="border border-dashed">
				<Empty.Header>
					<Empty.Media variant="icon"><BotIcon /></Empty.Media>
					<Empty.Title>None of your agents is live</Empty.Title>
					<Empty.Description>An agent shows here after it calls register_agent from one of your clients.</Empty.Description>
				</Empty.Header>
			</Empty.Root>
		{:else}
			<AgentsTable
				agents={agents.data.agents}
				{nowMs}
				triggerLabel="Revoke agent"
				revokeDescription="The agent can no longer call backchannels and frees one of your live agent slots. Its handle cannot be registered again, so this cannot be undone."
				onRevoke={revokeAgent}
			/>
		{/if}
	</div>
</section>
{/if}
