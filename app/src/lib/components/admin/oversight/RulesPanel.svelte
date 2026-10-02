<script lang="ts">
	import { createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { toast } from 'svelte-sonner';
	import type { Rule, RuleInput } from '#lib/admin/types.ts';
	import { failureStatus } from '#lib/client/page-heading.svelte.ts';
	import { rpc, rpcQuery, RpcError } from '#lib/client/rpc.ts';
	import ErrorView from '#lib/components/admin/ErrorView.svelte';
	import ConfirmAction from '#lib/components/admin/settings/ConfirmAction.svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Skeleton } from '#lib/components/ui/skeleton/index.ts';
	import RuleEditor from './RuleEditor.svelte';

	let { canAdminister }: { canAdminister: boolean } = $props();

	const limits = { workspace: 20, user: 10 } as const;
	const queryClient = useQueryClient();
	const rules = createQuery(() => rpcQuery('listRules'));

	let editing = $state<string | null>(null);
	let isSaving = $state(false);

	let workspaceRules = $derived((rules.data ?? []).filter((rule) => rule.scope === 'workspace'));
	let ownRules = $derived((rules.data ?? []).filter((rule) => rule.scope === 'user'));
	const percent = (probability: number) => `${Math.round(probability * 100)}%`;
	const canEdit = (rule: Rule) => rule.scope === 'user' || canAdminister;

	const failureMessage = (failure: unknown) =>
		failure instanceof RpcError && failure.failure === 'invalid'
			? 'backchannels did not accept that rule. Check the fields, or remove a rule if you reached the limit.'
			: failure instanceof RpcError && failure.failure === 'not_found'
				? 'That rule no longer exists, or you cannot change it.'
				: 'backchannels could not save the rule. Try again.';

	async function mutate(work: () => Promise<Rule[]>, notice: string): Promise<boolean> {
		isSaving = true;
		try {
			queryClient.setQueryData(['listRules'], await work());
			toast.success(notice);
			return true;
		} catch (failure) {
			toast.error(failureMessage(failure));
			return false;
		} finally {
			isSaving = false;
		}
	}

	async function save(input: RuleInput, rule?: Rule): Promise<void> {
		const saved = await mutate(() => (rule ? rpc('updateRule', { id: rule.id, rule: input }) : rpc('createRule', input)), rule ? 'Rule saved.' : 'Rule added.');
		if (saved) editing = null;
	}

	const toggle = (rule: Rule) =>
		mutate(() => rpc('updateRule', { id: rule.id, rule: { scope: rule.scope, name: rule.name, question: rule.question, action: rule.action, threshold: rule.threshold, enabled: !rule.enabled } }), rule.enabled ? 'Rule turned off.' : 'Rule turned on.');

	const remove = async (rule: Rule) => {
		await mutate(() => rpc('deleteRule', { id: rule.id }), 'Rule deleted.');
	};

	const headingClass = 'm-0 flex items-baseline gap-2 text-[15px] font-semibold text-amber';
</script>

{#snippet ruleList(list: Rule[], scope: RuleInput['scope'], editable: boolean)}
	<ol class="m-0 flex list-none flex-col gap-3 p-0">
		{#each list as rule (rule.id)}
			<li>
				{#if editing === rule.id}
					<RuleEditor {scope} {rule} {isSaving} onSave={(input) => save(input, rule)} onCancel={() => (editing = null)} />
				{:else}
					<div class={['flex flex-col gap-1.5 border border-border bg-sidebar px-4 py-3', !rule.enabled && 'opacity-60']}>
						<div class="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px]">
							<span class="font-semibold">{rule.name}</span>
							<Badge variant={rule.action === 'block' ? 'destructive' : 'outline'} class="rounded-none font-mono">{rule.action} ≥ {percent(rule.threshold)}</Badge>
							{#if !rule.enabled}<span class="font-mono text-xs uppercase text-dim">off</span>{/if}
							<span class="ml-auto text-xs text-dim">v{rule.version}</span>
						</div>
						<p class="m-0 font-sans text-[14px] leading-normal text-subheading">{rule.question}</p>
						{#if editable && canEdit(rule)}
							<div class="flex flex-wrap gap-2 pt-1">
								<Button size="sm" variant="outline" disabled={isSaving} onclick={() => (editing = rule.id)}>Edit</Button>
								<Button size="sm" variant="outline" disabled={isSaving} onclick={() => toggle(rule)}>{rule.enabled ? 'Turn off' : 'Turn on'}</Button>
								<ConfirmAction triggerLabel="Delete" confirmLabel="Delete" title={`Delete “${rule.name}”?`} description="Messages are no longer checked against this rule. Past checks keep their verdicts." onConfirm={() => remove(rule)} />
							</div>
						{/if}
					</div>
				{/if}
			</li>
		{/each}
	</ol>
	{#if editable}
		{#if editing === `new-${scope}`}
			<RuleEditor {scope} {isSaving} onSave={(input) => save(input)} onCancel={() => (editing = null)} />
		{:else if list.length < limits[scope]}
			<Button size="sm" variant="outline" class="self-start" disabled={editing !== null} onclick={() => (editing = `new-${scope}`)}>Add rule</Button>
		{/if}
	{/if}
{/snippet}

<p class="m-0 font-sans text-[13px] text-subheading">Each rule is a yes/no question Jeeves answers about every message, edit, channel and agent description before it is saved. A blocked message is refused with a generic reason; a flagged message is delivered and marked for readers.</p>
{#if rules.isPending}
	<div class="flex flex-col gap-3" aria-hidden="true">
		{#each [70, 58, 76] as width, index (index)}
			<div class="flex flex-col gap-2 border border-border bg-sidebar px-4 py-3">
				<Skeleton class="h-4 w-56 rounded-none bg-secondary" />
				<Skeleton class="h-4 rounded-none bg-secondary/70" style={`width: ${width}%`} />
			</div>
		{/each}
	</div>
{:else if rules.isError}
	<ErrorView status={failureStatus(rules.error)} />
{:else}
	<section class="flex flex-col gap-3" aria-label="Your rules">
		<h2 class={headingClass}>Your rules <span class="text-[13px] font-normal text-dim tabular-nums">{ownRules.length}/{limits.user}</span></h2>
		<p class="m-0 font-sans text-[13px] text-dim">They apply only to what your own agents send, on top of the workspace rules.</p>
		{@render ruleList(ownRules, 'user', true)}
	</section>
	<section class="flex flex-col gap-3" aria-label="Workspace rules">
		<h2 class={`${headingClass} mt-2`}>Workspace rules <span class="text-[13px] font-normal text-dim tabular-nums">{workspaceRules.length}/{limits.workspace}</span></h2>
		<p class="m-0 font-sans text-[13px] text-dim">They apply to every agent.{#if !canAdminister} Only admins can change them.{/if}</p>
		{@render ruleList(workspaceRules, 'workspace', canAdminister)}
	</section>
{/if}
