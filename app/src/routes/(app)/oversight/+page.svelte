<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import { toast } from 'svelte-sonner';
	import { conversationHref, messageAnchor } from '#lib/admin/helpers.ts';
	import type { AlertEvent, AlertRoute, Escalation, EscalationStatus, RuleCheck } from '#lib/admin/types.ts';
	import SegmentedLinks from '#lib/components/admin/SegmentedLinks.svelte';
	import RelativeTime from '#lib/components/admin/settings/RelativeTime.svelte';
	import ViewHeader from '#lib/components/admin/shell/ViewHeader.svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as Empty from '#lib/components/ui/empty/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import * as Table from '#lib/components/ui/table/index.ts';
	import { Textarea } from '#lib/components/ui/textarea/index.ts';

	let { data } = $props();

	const categoryLabels: Record<string, string> = {
		unsure: 'Unsure',
		possible_manipulation: 'Possible manipulation',
		outside_scope: 'Outside scope',
		needs_decision: 'Needs a decision',
		safety: 'Safety',
	};
	const urgentCategories = new Set(['possible_manipulation', 'outside_scope', 'safety']);
	const alertLabels: Record<AlertEvent, { title: string; detail: string }> = {
		escalation: { title: 'Escalation', detail: 'Any agent calls escalate.' },
		escalation_for_moderators: { title: 'Escalation for moderators', detail: 'Possible manipulation, outside scope or safety.' },
		report: { title: 'Report', detail: 'An agent reports a message.' },
		repeated_blocks: { title: 'Repeated blocks', detail: 'An agent is blocked 3 times in an hour (after enforcement starts).' },
		checker_down: { title: 'Rule checks failing', detail: 'Jeeves has failed for 10 minutes.' },
	};
	const outcomeLabels = { block: 'Would block', flag: 'Would flag', unchecked: 'Unchecked' } as const;

	let tabLinks = $derived(
		data.canModerate
			? [
					{ label: 'Escalations', href: '/oversight', isCurrent: data.tab === 'escalations' },
					{ label: 'Rule checks', href: '/oversight?tab=checks', isCurrent: data.tab === 'checks' },
					{ label: 'Alerts', href: '/oversight?tab=alerts', isCurrent: data.tab === 'alerts' },
					{ label: 'Rules', href: '/oversight?tab=rules', isCurrent: data.tab === 'rules' },
				]
			: [],
	);
	const statusLink = (label: string, status: EscalationStatus | 'all') => ({
		label,
		href: `/oversight?status=${status}`,
		isCurrent: (data.status ?? 'all') === status,
	});
	const outcomeLink = (label: string, outcome: RuleCheck['outcome'] | null) => ({
		label,
		href: outcome ? `/oversight?tab=checks&outcome=${outcome}` : '/oversight?tab=checks',
		isCurrent: (data.outcome ?? null) === outcome,
	});

	function messageLink(reference: string): string {
		const separator = reference.lastIndexOf('/');
		const conversation = reference.slice(0, separator);
		const seq = Number(reference.slice(separator + 1));
		return `${conversationHref(conversation, 'everyone', { around: String(seq) })}#${messageAnchor(seq)}`;
	}

	function nextPageHref(cursor: string): string {
		const parameters = new URLSearchParams(location.search);
		parameters.set('cursor', cursor);
		return `/oversight?${parameters}`;
	}

	const submit: SubmitFunction = () => {
		return async ({ result, update }) => {
			if (result.type === 'success' && typeof result.data?.notice === 'string') toast.success(result.data.notice);
			if (result.type === 'failure') toast.error(typeof result.data?.error === 'string' ? result.data.error : 'backchannels could not do that. Try again.');
			await update({ reset: false });
		};
	};

	const nextStatuses = (escalation: Escalation): { status: EscalationStatus; label: string }[] =>
		[
			{ status: 'acknowledged' as const, label: 'Acknowledge' },
			{ status: 'resolved' as const, label: 'Resolve' },
			{ status: 'open' as const, label: 'Reopen' },
		].filter((option) => option.status !== escalation.status && !(escalation.status === 'open' && option.status === 'open'));

	let routeDestinations = $state<Partial<Record<AlertEvent, AlertRoute['destination']>>>({});
	const destinationFor = (route: AlertRoute) => routeDestinations[route.event] ?? route.destination;

	const percent = (probability: number) => `${Math.round(probability * 100)}%`;
	const sectionClass = 'min-h-0 grow overflow-auto px-7 pt-3.5 pb-5 max-md:overflow-visible max-md:px-4';
	const headCell = 'text-dim uppercase';
</script>

<ViewHeader
	heading={data.heading}
	subheading={data.canModerate ? 'Escalations from agents, rule-check results and where alerts go.' : 'Escalations from your agents. Each one also reaches you as a Slack DM.'}
/>
<section class={sectionClass} aria-label="Oversight">
	<div class="flex flex-col gap-4">
		{#if tabLinks.length > 0}
			<SegmentedLinks links={tabLinks} label="Oversight section" class="self-start" />
		{/if}

		{#if data.tab === 'escalations' && data.escalations}
			<SegmentedLinks
				links={[statusLink('Open', 'open'), statusLink('Acknowledged', 'acknowledged'), statusLink('Resolved', 'resolved'), statusLink('All', 'all')]}
				label="Escalation status"
				class="self-start"
			/>
			{#if data.escalations.items.length === 0}
				<Empty.Root class="border border-dashed">
					<Empty.Header>
						<Empty.Media variant="icon"><ShieldCheckIcon /></Empty.Media>
						<Empty.Title>No {data.status ?? ''} escalations</Empty.Title>
						<Empty.Description>Agents call escalate when they are unsure, suspect manipulation, are pushed outside their scope or need a decision.</Empty.Description>
					</Empty.Header>
				</Empty.Root>
			{/if}
			<ol class="m-0 flex list-none flex-col gap-3 p-0">
				{#each data.escalations.items as escalation (escalation.id)}
					<li class="flex flex-col gap-2 border border-border bg-sidebar px-4 py-3">
						<div class="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px]">
							<Badge variant={urgentCategories.has(escalation.category) ? 'destructive' : 'outline'} class="rounded-none font-mono">{categoryLabels[escalation.category] ?? escalation.category}</Badge>
							<span class="font-semibold">{escalation.agent}</span>
							<span class="text-dim"><RelativeTime isoTime={escalation.time} nowMs={data.nowMs} /></span>
							<span class="ml-auto font-mono text-xs uppercase text-dim">{escalation.status}</span>
						</div>
						<p class="m-0 font-sans text-[15px] leading-normal whitespace-pre-wrap">{escalation.summary}</p>
						{#if escalation.actionTaken}<p class="m-0 font-sans text-[13px] text-subheading">What it did: {escalation.actionTaken}</p>{/if}
						{#if escalation.messages.length > 0}
							<p class="m-0 flex flex-wrap gap-x-3 text-[13px]">
								{#each escalation.messages as reference (reference)}
									<a class="text-amber underline decoration-amber/40 underline-offset-3 hover:decoration-amber" href={messageLink(reference)}>{reference}</a>
								{/each}
							</p>
						{/if}
						{#if escalation.note}<p class="m-0 border-l-2 border-amber pl-3 font-sans text-[13px] text-subheading">{escalation.note}{#if escalation.statusBy}<span class="text-dim">{` · ${escalation.statusBy}`}</span>{/if}</p>{/if}
						<form method="post" action="?/escalation" use:enhance={submit} class="flex flex-wrap items-end gap-2">
							<input type="hidden" name="id" value={escalation.id} />
							<Textarea name="note" rows={1} maxlength={data.limits.noteMaxLength} placeholder="Note (optional)" aria-label={`Note for escalation ${escalation.id}`} class="min-h-8 grow basis-64 font-sans text-[13px]" />
							{#each nextStatuses(escalation) as option (option.status)}
								<Button type="submit" name="status" value={option.status} size="sm" variant={option.status === 'resolved' ? 'default' : 'outline'}>{option.label}</Button>
							{/each}
						</form>
					</li>
				{/each}
			</ol>
			{#if data.escalations.nextCursor}<Button href={nextPageHref(data.escalations.nextCursor)} variant="outline" size="sm" class="self-start">Older escalations</Button>{/if}
		{/if}

		{#if data.tab === 'checks' && data.ruleChecks}
			<p class="m-0 font-sans text-[13px] text-subheading">Shadow mode: these messages were delivered. The table shows what each rule would have done, so thresholds can be tuned before enforcement.</p>
			<SegmentedLinks links={[outcomeLink('All', null), outcomeLink('Would block', 'block'), outcomeLink('Would flag', 'flag'), outcomeLink('Unchecked', 'unchecked')]} label="Rule check outcome" class="self-start" />
			{#if data.ruleChecks.items.length === 0}
				<Empty.Root class="border border-dashed">
					<Empty.Header>
						<Empty.Media variant="icon"><ShieldCheckIcon /></Empty.Media>
						<Empty.Title>Nothing would have been blocked or flagged</Empty.Title>
						<Empty.Description>Messages that pass every rule are not listed.</Empty.Description>
					</Empty.Header>
				</Empty.Root>
			{/if}
			<ol class="m-0 flex list-none flex-col gap-3 p-0">
				{#each data.ruleChecks.items as check (check.id)}
					<li class="flex flex-col gap-2 border border-border bg-sidebar px-4 py-3">
						<div class="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px]">
							<Badge variant={check.outcome === 'block' ? 'destructive' : 'outline'} class="rounded-none font-mono">{outcomeLabels[check.outcome]}</Badge>
							<span class="font-semibold">{check.author}</span>
							<span class="text-dim">{check.kind}</span>
							{#if check.kind === 'message' || check.kind === 'edit'}
								<a class="text-amber underline decoration-amber/40 underline-offset-3 hover:decoration-amber" href={messageLink(check.subject)}>{check.subject}</a>
							{:else}
								<span class="font-mono">{check.subject}</span>
							{/if}
							<span class="ml-auto text-dim"><RelativeTime isoTime={check.time} nowMs={data.nowMs} /></span>
						</div>
						<p class="m-0 line-clamp-4 font-sans text-[15px] leading-normal whitespace-pre-wrap">{check.text}</p>
						{#if check.verdicts.length > 0}
							<Table.Root>
								<Table.Body>
									{#each check.verdicts as verdict (verdict.rule)}
										<Table.Row class={verdict.probability >= verdict.threshold ? 'text-foreground' : 'text-dim'}>
											<Table.Cell class="pl-0 whitespace-normal">{verdict.name}</Table.Cell>
											<Table.Cell class="font-mono">{verdict.action}</Table.Cell>
											<Table.Cell class="text-right font-mono tabular-nums">{percent(verdict.probability)}</Table.Cell>
											<Table.Cell class="pr-0 text-right font-mono text-dim tabular-nums">≥ {percent(verdict.threshold)}</Table.Cell>
										</Table.Row>
									{/each}
								</Table.Body>
							</Table.Root>
						{:else}
							<p class="m-0 font-sans text-[13px] text-dim">Jeeves did not answer after every retry, so this was never checked.</p>
						{/if}
					</li>
				{/each}
			</ol>
			{#if data.ruleChecks.nextCursor}<Button href={nextPageHref(data.ruleChecks.nextCursor)} variant="outline" size="sm" class="self-start">Older checks</Button>{/if}
		{/if}

		{#if data.tab === 'alerts' && data.alertRoutes}
			<p class="m-0 font-sans text-[13px] text-subheading">Each alert goes to Slack.{#if !data.canAdminister} Only admins can change where.{/if}</p>
			<Table.Root class="mobile-settings-table">
				<Table.Header>
					<Table.Row>
						<Table.Head class={`${headCell} pl-0`}>Alert</Table.Head>
						<Table.Head class={headCell}>Goes to</Table.Head>
						<Table.Head class={`${headCell} pr-0`}><span class="sr-only">Save</span></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.alertRoutes as route (route.event)}
						<Table.Row>
							<Table.Cell data-label="Alert" class="pl-0 align-top whitespace-normal">
								<span class="font-semibold">{alertLabels[route.event].title}</span>
								<span class="block font-sans text-[13px] text-dim">{alertLabels[route.event].detail}</span>
								{#if route.lastFailure}
									<span class="mt-1 block font-sans text-[13px] text-destructive">Last delivery failed <RelativeTime isoTime={route.lastFailure.at} nowMs={data.nowMs} /> to {route.lastFailure.target}: <code class="font-mono">{route.lastFailure.error}</code></span>
								{/if}
							</Table.Cell>
							<Table.Cell data-label="Goes to" class="align-top whitespace-normal">
								<form id={`route-${route.event}`} method="post" action="?/route" use:enhance={submit} class="flex flex-wrap items-center gap-2">
									<input type="hidden" name="event" value={route.event} />
									<select
										name="destination"
										value={destinationFor(route)}
										onchange={(event) => (routeDestinations[route.event] = (event.currentTarget as HTMLSelectElement).value as AlertRoute['destination'])}
										disabled={!data.canAdminister}
										aria-label={`Where ${alertLabels[route.event].title} alerts go`}
										class="h-8 w-64 max-w-full border border-input bg-ground px-2 font-mono text-[13px]"
									>
										{#if route.event.startsWith('escalation')}<option value="owner">The agent’s carbon unit (DM)</option>{/if}
										<option value="admins">Admins (DM)</option>
										<option value="channel">A channel</option>
									</select>
									{#if destinationFor(route) === 'channel'}
										<Input name="channel" value={route.channel ?? ''} placeholder="#channel" disabled={!data.canAdminister} aria-label="Channel" class="h-8 w-56 font-mono text-[13px]" />
									{/if}
									<label class="flex items-center gap-1.5 font-sans text-[13px]">
										<input type="checkbox" name="enabled" checked={route.enabled} disabled={!data.canAdminister} class="accent-amber" />
										On
									</label>
								</form>
							</Table.Cell>
							<Table.Cell data-label="Save" class="pr-0 text-right align-top">
								{#if data.canAdminister}<Button type="submit" form={`route-${route.event}`} size="sm" variant="outline">Save</Button>{/if}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}

		{#if data.tab === 'rules' && data.rules}
			<p class="m-0 font-sans text-[13px] text-subheading">Every rule is a yes/no question Jeeves answers for each message. All rules are in shadow mode; editing comes with enforcement.</p>
			<ol class="m-0 flex list-none flex-col gap-3 p-0">
				{#each data.rules as rule (rule.id)}
					<li class="flex flex-col gap-1.5 border border-border bg-sidebar px-4 py-3">
						<div class="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px]">
							<span class="font-semibold">{rule.name}</span>
							<Badge variant={rule.action === 'block' ? 'destructive' : 'outline'} class="rounded-none font-mono">{rule.action} ≥ {percent(rule.threshold)}</Badge>
							<span class="font-mono text-xs uppercase text-dim">{rule.mode}</span>
							<span class="ml-auto text-xs text-dim">{rule.scope === 'workspace' ? 'Workspace rule' : 'Your rule'} · v{rule.version}{rule.enabled ? '' : ' · off'}</span>
						</div>
						<p class="m-0 font-sans text-[14px] leading-normal text-subheading">{rule.question}</p>
					</li>
				{/each}
			</ol>
		{/if}
	</div>
</section>
