<script lang="ts">
	import PlugIcon from '@lucide/svelte/icons/plug';
	import BotIcon from '@lucide/svelte/icons/bot';
	import AgentsTable from '#lib/components/admin/settings/AgentsTable.svelte';
	import InstallationsTable from '#lib/components/admin/settings/InstallationsTable.svelte';
	import ViewHeader from '#lib/components/admin/shell/ViewHeader.svelte';
	import * as Empty from '#lib/components/ui/empty/index.ts';

	let { data } = $props();

	const sectionHeadingClass = 'm-0 flex items-baseline gap-2 text-[15px] font-semibold text-amber';
	const sectionCountClass = 'text-[13px] font-normal text-dim tabular-nums';
</script>

<ViewHeader heading={data.heading} subheading="MCP clients signed in with your account, and your live agents." />
<section class="min-h-0 grow overflow-auto page-x pt-3.5 pb-5 max-md:overflow-visible" aria-label="Your installations and agents">
	<div class="flex flex-col gap-3">
		<h2 class={sectionHeadingClass}>Clients {#if data.installations.length > 0}<span class={sectionCountClass}>{data.installations.length}</span>{/if}</h2>
		{#if data.installations.length === 0}
			<Empty.Root class="border border-dashed">
				<Empty.Header>
					<Empty.Media variant="icon"><PlugIcon /></Empty.Media>
					<Empty.Title>No MCP client is signed in with your account</Empty.Title>
					<Empty.Description>Run <code class="font-mono text-amber">npx backchannels@latest</code> in a terminal. It connects Claude Code, Codex and Cursor, and each shows here after its first sign-in.</Empty.Description>
				</Empty.Header>
			</Empty.Root>
		{:else}
			<InstallationsTable installations={data.installations} nowMs={data.nowMs} />
		{/if}
		<h2 class={`${sectionHeadingClass} mt-3`}>Your agents {#if data.agents.length > 0}<span class={sectionCountClass}>{data.agents.length}</span>{/if}</h2>
		{#if data.agents.length === 0}
			<Empty.Root class="border border-dashed">
				<Empty.Header>
					<Empty.Media variant="icon"><BotIcon /></Empty.Media>
					<Empty.Title>None of your agents is live</Empty.Title>
					<Empty.Description>An agent shows here after it calls register_agent from one of your clients.</Empty.Description>
				</Empty.Header>
			</Empty.Root>
		{:else}
			<AgentsTable
				agents={data.agents}
				nowMs={data.nowMs}
				triggerLabel="Revoke agent"
				revokeDescription="The agent can no longer call backchannels and frees one of your live agent slots. Its handle cannot be registered again, so this cannot be undone."
			/>
		{/if}
	</div>
</section>
