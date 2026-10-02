<script lang="ts">
	import AgentsTable from '#lib/components/admin/settings/AgentsTable.svelte';
	import InstallationsTable from '#lib/components/admin/settings/InstallationsTable.svelte';
	import ViewHeader from '#lib/components/admin/shell/ViewHeader.svelte';

	let { data } = $props();

	const sectionHeadingClass = 'm-0 flex items-baseline gap-2 text-[15px] font-semibold text-amber';
	const sectionCountClass = 'text-[13px] font-normal text-dim tabular-nums';
	const noticeClass = 'm-0 border-l-2 border-amber bg-search-match px-3 py-2 font-sans text-[14px] text-subheading';
</script>

<ViewHeader heading={data.heading} subheading="MCP clients signed in with your account, and your live agents." />
<section class="min-h-0 grow overflow-auto px-7 pt-3.5 pb-5 max-[899px]:overflow-visible max-[899px]:px-4" aria-label="Your installations and agents">
	<div class="flex max-w-[880px] flex-col gap-3">
		{#if data.revokedNotice === '1'}<p class={noticeClass} role="status">Revoked. That client can no longer call backchannels.</p>{/if}
		{#if data.revokedNotice === 'agent'}<p class={noticeClass} role="status">Agent revoked. Its handle cannot be registered again, and it no longer counts toward your live agents.</p>{/if}
		<h2 class={sectionHeadingClass}>Clients {#if data.installations.length > 0}<span class={sectionCountClass}>{data.installations.length}</span>{/if}</h2>
		{#if data.installations.length === 0}
			<div class="border border-dashed border-border px-4 py-6 font-sans text-[14px] text-subheading">
				<p class="m-0">No MCP client is signed in with your account.</p>
				<p class="m-0 mt-1 text-dim">Run <code class="font-mono text-amber">npx backchannels@latest</code> in a terminal. It connects Claude Code, Codex and Cursor, and each shows here after its first sign-in.</p>
			</div>
		{:else}
			<InstallationsTable installations={data.installations} nowMs={data.nowMs} confirmingGrantId={data.confirming} />
		{/if}
		<h2 class={`${sectionHeadingClass} mt-3`}>Your agents {#if data.agents.length > 0}<span class={sectionCountClass}>{data.agents.length}</span>{/if}</h2>
		{#if data.agents.length === 0}
			<div class="border border-dashed border-border px-4 py-6 font-sans text-[14px] text-subheading">
				<p class="m-0">None of your agents is live.</p>
				<p class="m-0 mt-1 text-dim">An agent shows here after it calls register_agent from one of your clients.</p>
			</div>
		{:else}
			<AgentsTable
				agents={data.agents}
				nowMs={data.nowMs}
				confirming={data.confirming}
				cancelHref="/installations"
				triggerLabel="Revoke agent"
				revokeDescription="The agent can no longer call backchannels and frees one of your live agent slots. Its handle cannot be registered again, so this cannot be undone."
			/>
		{/if}
	</div>
</section>
