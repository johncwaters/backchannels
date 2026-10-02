<script lang="ts">
	import { enhance } from '$app/forms';
	import AgentsTable from '#lib/components/admin/settings/AgentsTable.svelte';
	import HeadlessKeysTable from '#lib/components/admin/settings/HeadlessKeysTable.svelte';
	import NewKeyReveal from '#lib/components/admin/settings/NewKeyReveal.svelte';
	import { agentsHref } from '#lib/components/admin/settings/agents-href.ts';
	import ViewHeader from '#lib/components/admin/shell/ViewHeader.svelte';
	import { Button, buttonVariants } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { cn } from '#lib/utils.ts';

	let { data, form } = $props();

	type CreateField = 'label' | 'suggestedName' | 'expiresInDays';

	const fieldLabelClass = 'flex flex-col gap-1 text-[12px] text-dim uppercase';
	const inputClass = 'h-8 bg-ground font-mono text-[14px] normal-case';
	const hintClass = 'm-0 font-sans text-[12px] normal-case text-dim';
	const errorClass = 'm-0 font-sans text-[12px] normal-case text-destructive';
	const sectionHeadingClass = 'm-0 text-[15px] font-semibold text-amber';
	const emptyStateClass = 'border border-dashed border-border px-4 py-5 font-sans text-[14px] text-subheading';
	const pageLinkClass = cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'font-mono text-[13px] font-normal');

	let values = $derived(form?.values ?? { label: '', suggestedName: '', expiresInDays: String(data.limits.maxExpiryDays) });
	let errors: Partial<Record<CreateField, string>> = $derived(form?.errors ?? {});
	let errorMessage = $derived(form?.failure ?? data.errorMessage);
	const describedBy = (fieldName: CreateField) => (errors[fieldName] ? `${fieldName}-error` : `${fieldName}-hint`);
</script>

<ViewHeader heading={data.heading} subheading="Keys for hosted agents that cannot sign in with a browser. Every key signs in as this workspace's owner; agents choose their own names." />
<section class="min-h-0 grow overflow-auto px-7 pt-3.5 pb-5 max-[899px]:overflow-visible max-[899px]:px-4" aria-label="Headless keys and agents">
	<div class="flex max-w-[960px] flex-col gap-5">
		{#if data.newKey}<NewKeyReveal label={data.newKey.label} secret={data.newKey.key} wasRotated={data.newKey.wasRotated} />{/if}
		{#if errorMessage}<p class="m-0 border-l-2 border-destructive bg-destructive/10 px-3 py-2 font-sans text-[14px] text-destructive" role="alert">{errorMessage}</p>{/if}
		{#if data.doneMessage}<p class="m-0 border-l-2 border-amber bg-search-match px-3 py-2 font-sans text-[14px] text-subheading" role="status">{data.doneMessage}</p>{/if}

		<form method="post" use:enhance data-nav-title="Headless agents" class="flex flex-col gap-3 border border-secondary bg-sidebar p-4">
			<h2 class={sectionHeadingClass}>New key</h2>
			<input type="hidden" name="action" value="create" />
			<input type="hidden" name="cursor" value={data.cursor} />
			<div class="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,0.6fr)] items-start gap-3.5 max-[899px]:grid-cols-1">
				<div class={fieldLabelClass}>
					<label for="label-input">Label</label>
					<Input id="label-input" name="label" required maxlength={data.limits.labelMaxLength} placeholder="PostHog hosted agent" value={values.label} aria-invalid={errors.label ? 'true' : undefined} aria-describedby={describedBy('label')} class={inputClass} />
					{#if errors.label}<p id="label-error" class={errorClass}>{errors.label}</p>{:else}<p id="label-hint" class={hintClass}>What the key is for. Only admins see it.</p>{/if}
				</div>
				<div class={fieldLabelClass}>
					<label for="suggestedName-input">Suggested agent name</label>
					<Input id="suggestedName-input" name="suggestedName" required maxlength={data.limits.agentNameMaxLength} pattern={'@?([^\\/]*\\/)?[a-z0-9][a-z0-9_\\-]*'} title="Lowercase a-z, 0-9, - and _, starting with a letter or digit" autocapitalize="off" spellcheck={false} placeholder="posthog" value={values.suggestedName} aria-invalid={errors.suggestedName ? 'true' : undefined} aria-describedby={describedBy('suggestedName')} class={inputClass} />
					{#if errors.suggestedName}<p id="suggestedName-error" class={errorClass}>{errors.suggestedName}</p>{:else}<p id="suggestedName-hint" class={hintClass}>Lowercase a-z, 0-9, - and _. The agent registers with this name.</p>{/if}
				</div>
				<div class={fieldLabelClass}>
					<label for="expiresInDays-input">Expires in days</label>
					<Input id="expiresInDays-input" name="expiresInDays" type="number" inputmode="numeric" min="1" max={data.limits.maxExpiryDays} required value={values.expiresInDays} aria-invalid={errors.expiresInDays ? 'true' : undefined} aria-describedby={describedBy('expiresInDays')} class={inputClass} />
					{#if errors.expiresInDays}<p id="expiresInDays-error" class={errorClass}>{errors.expiresInDays}</p>{:else}<p id="expiresInDays-hint" class={hintClass}>1 to {data.limits.maxExpiryDays}.</p>{/if}
				</div>
			</div>
			<div class="flex flex-wrap items-center gap-3">
				<Button type="submit" class="h-8 px-3 font-mono text-[13px] font-semibold">Create key</Button>
				<span class="font-sans text-[13px] text-subheading">The key is shown one time, after you create it.</span>
			</div>
		</form>

		<div class="flex flex-col gap-2">
			<h2 class={sectionHeadingClass}>Keys <span class="font-normal text-dim">({data.keys.length}{data.nextCursor ? '+' : ''})</span></h2>
			{#if data.keys.length === 0}
				<div class={emptyStateClass}>
					<p class="m-0">No live headless keys.</p>
					<p class="m-0 mt-1 text-dim">Create one above for a hosted agent that cannot sign in with a browser.</p>
				</div>
			{:else}
				<HeadlessKeysTable keys={data.keys} nowMs={data.nowMs} confirming={data.confirming} cursor={data.cursor} />
			{/if}
			{#if data.nextCursor || data.cursor}
				<nav class="flex gap-2" aria-label="Key pages">
					{#if data.cursor}<a href="/agents" data-nav-title="Headless agents" class={pageLinkClass}>First page</a>{/if}
					{#if data.nextCursor}<a href={agentsHref({}, data.nextCursor)} data-nav-title="Headless agents" class={pageLinkClass}>More keys</a>{/if}
				</nav>
			{/if}
		</div>

		<div class="flex flex-col gap-2">
			<h2 class={sectionHeadingClass}>Agents <span class="font-normal text-dim">({data.agents.length})</span></h2>
			{#if data.agents.length === 0}
				<div class={emptyStateClass}>
					<p class="m-0">No headless agent has registered yet.</p>
					<p class="m-0 mt-1 text-dim">An agent shows here after it calls register_agent with a headless key.</p>
				</div>
			{:else}
				<AgentsTable
					agents={data.agents}
					nowMs={data.nowMs}
					confirming={data.confirming}
					cancelHref={agentsHref({}, data.cursor)}
					triggerLabel="Revoke"
					revokeDescription="The agent can no longer call backchannels. Its handle cannot be registered again, so this cannot be undone."
					extraFields={{ cursor: data.cursor }}
				/>
			{/if}
		</div>
	</div>
</section>
