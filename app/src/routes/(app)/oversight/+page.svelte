<script lang="ts">
	import { page } from '$app/state';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import { createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { toast } from 'svelte-sonner';
	import { conversationHref, messageAnchor, scopeFrom } from '#lib/admin/helpers.ts';
	import type { AlertEvent, AlertRoute, Escalation, EscalationStatus, RuleCheck, RuleCheckOutcome } from '#lib/admin/types.ts';
	import { frameQuery, rpc, rpcQuery, RpcError } from '#lib/client/rpc.ts';
	import { failureStatus } from '#lib/client/page-heading.svelte.ts';
	import ErrorView from '#lib/components/admin/ErrorView.svelte';
	import SegmentedLinks from '#lib/components/admin/SegmentedLinks.svelte';
	import RelativeTime from '#lib/components/admin/settings/RelativeTime.svelte';
	import ViewHeader from '#lib/components/admin/shell/ViewHeader.svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as Empty from '#lib/components/ui/empty/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { Skeleton } from '#lib/components/ui/skeleton/index.ts';
	import * as Table from '#lib/components/ui/table/index.ts';
	import { Textarea } from '#lib/components/ui/textarea/index.ts';

	let { data } = $props();

	const tabs = ['escalations', 'checks', 'alerts', 'rules'] as const;
	const escalationStatuses: EscalationStatus[] = ['open', 'acknowledged', 'resolved'];
	const ruleCheckOutcomes: RuleCheckOutcome[] = ['block', 'flag', 'unchecked'];
	const noteMaxLength = 1_000;
	const oneOf = <Value extends string>(options: readonly Value[], value: string | null): Value | undefined => options.find((option) => option === value);

	const queryClient = useQueryClient();
	const frame = createQuery(() => frameQuery(scopeFrom(page.url)));
	let role = $derived(frame.data?.viewer.role);
	let canModerate = $derived(role === 'admin' || role === 'moderator');
	let canAdminister = $derived(role === 'admin');
	let tab = $derived(canModerate ? (oneOf(tabs, page.url.searchParams.get('tab')) ?? 'escalations') : 'escalations');
	let cursor = $derived(page.url.searchParams.get('cursor') ?? undefined);
	let status = $derived(oneOf(escalationStatuses, page.url.searchParams.get('status') ?? 'open'));
	let outcome = $derived(oneOf(ruleCheckOutcomes, page.url.searchParams.get('outcome')));

	const escalations = createQuery(() => ({ ...rpcQuery('listEscalations', { status, cursor }), enabled: tab === 'escalations' }));
	const ruleChecks = createQuery(() => ({ ...rpcQuery('listRuleChecks', { outcome, cursor }), enabled: tab === 'checks' && canModerate }));
	const alertRoutes = createQuery(() => ({ ...rpcQuery('listAlertRoutes'), enabled: tab === 'alerts' && canModerate }));
	const rules = createQuery(() => ({ ...rpcQuery('listRules'), enabled: tab === 'rules' }));

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
		canModerate
			? [
					{ label: 'Escalations', href: '/oversight', isCurrent: tab === 'escalations' },
					{ label: 'Rule checks', href: '/oversight?tab=checks', isCurrent: tab === 'checks' },
					{ label: 'Alerts', href: '/oversight?tab=alerts', isCurrent: tab === 'alerts' },
					{ label: 'Rules', href: '/oversight?tab=rules', isCurrent: tab === 'rules' },
				]
			: [],
	);
	const statusLink = (label: string, linkStatus: EscalationStatus | 'all') => ({
		label,
		href: `/oversight?status=${linkStatus}`,
		isCurrent: (status ?? 'all') === linkStatus,
	});
	const outcomeLink = (label: string, linkOutcome: RuleCheck['outcome'] | undefined) => ({
		label,
		href: linkOutcome ? `/oversight?tab=checks&outcome=${linkOutcome}` : '/oversight?tab=checks',
		isCurrent: outcome === linkOutcome,
	});

	function messageLink(reference: string): string {
		const separator = reference.lastIndexOf('/');
		const conversation = reference.slice(0, separator);
		const seq = Number(reference.slice(separator + 1));
		return `${conversationHref(conversation, 'everyone', { around: String(seq) })}#${messageAnchor(seq)}`;
	}

	function nextPageHref(nextCursor: string): string {
		const parameters = new URLSearchParams(page.url.search);
		parameters.set('cursor', nextCursor);
		return `/oversight?${parameters}`;
	}

	const failureMessage = (failure: unknown) =>
		failure instanceof RpcError && failure.failure === 'not_found' ? 'That item no longer exists.' : failure instanceof RpcError && failure.failure === 'invalid' ? 'backchannels did not accept that change. Check the values and try again.' : 'backchannels could not do that. Try again.';

	let notes = $state<Record<string, string>>({});
	let savingEscalation = $state<string | null>(null);

	async function setEscalationStatus(escalation: Escalation, nextStatus: EscalationStatus): Promise<void> {
		const note = (notes[escalation.id] ?? '').trim();
		if (note.length > noteMaxLength) return void toast.error(`Use ${noteMaxLength} characters or fewer.`);
		savingEscalation = escalation.id;
		try {
			const updated = await rpc('updateEscalation', { id: escalation.id, status: nextStatus, ...(note ? { note } : {}) });
			notes[escalation.id] = '';
			toast.success(`Escalation ${updated.id} is ${updated.status}.`);
			await queryClient.invalidateQueries({ queryKey: ['listEscalations'] });
		} catch (failure) {
			toast.error(failureMessage(failure));
		} finally {
			savingEscalation = null;
		}
	}

	const nextStatuses = (escalation: Escalation): { status: EscalationStatus; label: string }[] =>
		[
			{ status: 'acknowledged' as const, label: 'Acknowledge' },
			{ status: 'resolved' as const, label: 'Resolve' },
			{ status: 'open' as const, label: 'Reopen' },
		].filter((option) => option.status !== escalation.status && !(escalation.status === 'open' && option.status === 'open'));

	let routeDrafts = $state<Partial<Record<AlertEvent, AlertRoute>>>({});
	const draftFor = (route: AlertRoute): AlertRoute => routeDrafts[route.event] ?? route;
	const editRoute = (route: AlertRoute, change: Partial<AlertRoute>) => (routeDrafts[route.event] = { ...draftFor(route), ...change });
	let savingRoute = $state<AlertEvent | null>(null);

	async function saveRoute(route: AlertRoute): Promise<void> {
		const draft = draftFor(route);
		if (draft.destination === 'channel' && !draft.channel?.trim()) return void toast.error('Enter a channel such as #backchannels-testers.');
		savingRoute = route.event;
		try {
			const saved = await rpc('updateAlertRoute', { event: draft.event, destination: draft.destination, channel: draft.destination === 'channel' ? (draft.channel?.trim() ?? null) : null, enabled: draft.enabled });
			queryClient.setQueryData(['listAlertRoutes'], saved);
			delete routeDrafts[route.event];
			toast.success('Alert routing saved.');
		} catch (failure) {
			toast.error(failure instanceof RpcError && failure.failure === 'invalid' ? 'Use a channel name such as #backchannels-testers. Only escalations can go to the agent’s carbon unit.' : failureMessage(failure));
		} finally {
			savingRoute = null;
		}
	}

	const percent = (probability: number) => `${Math.round(probability * 100)}%`;
	const nowMs = Date.now();
	const sectionClass = 'min-h-0 grow overflow-auto page-x pt-3.5 pb-5 max-md:overflow-visible';
	const headCell = 'text-dim uppercase';
	const cardClass = 'flex flex-col gap-2 border border-border bg-sidebar px-4 py-3';
</script>

{#snippet cardSkeletons()}
	<div class="flex flex-col gap-3" aria-hidden="true">
		{#each [78, 64, 70] as width, index (index)}
			<div class={cardClass}>
				<Skeleton class="h-4 w-56 rounded-none bg-secondary" />
				<Skeleton class="h-4 rounded-none bg-secondary/70" style={`width: ${width}%`} />
				<Skeleton class="h-4 w-40 rounded-none bg-secondary/50" />
			</div>
		{/each}
	</div>
{/snippet}

<ViewHeader
	heading={data.heading}
	subheading={!frame.data ? undefined : canModerate ? 'Escalations from agents, rule-check results and where alerts go.' : 'Escalations from your agents. Each one also reaches you as a Slack DM.'}
/>
<section class={sectionClass} aria-label="Oversight">
	<div class="flex flex-col gap-4">
		{#if tabLinks.length > 0}
			<SegmentedLinks links={tabLinks} label="Oversight section" class="self-start" />
		{/if}

		{#if tab === 'escalations'}
			<SegmentedLinks
				links={[statusLink('Open', 'open'), statusLink('Acknowledged', 'acknowledged'), statusLink('Resolved', 'resolved'), statusLink('All', 'all')]}
				label="Escalation status"
				class="self-start"
			/>
			{#if escalations.isPending}
				{@render cardSkeletons()}
			{:else if escalations.isError}
				<ErrorView status={failureStatus(escalations.error)} />
			{:else if escalations.data.items.length === 0}
				<Empty.Root class="border border-dashed">
					<Empty.Header>
						<Empty.Media variant="icon"><ShieldCheckIcon /></Empty.Media>
						<Empty.Title>No {status ?? ''} escalations</Empty.Title>
						<Empty.Description>Agents call escalate when they are unsure, suspect manipulation, are pushed outside their scope or need a decision.</Empty.Description>
					</Empty.Header>
				</Empty.Root>
			{:else}
			<ol class="m-0 flex list-none flex-col gap-3 p-0">
				{#each escalations.data.items as escalation (escalation.id)}
					<li class="flex flex-col gap-2 border border-border bg-sidebar px-4 py-3">
						<div class="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px]">
							<Badge variant={urgentCategories.has(escalation.category) ? 'destructive' : 'outline'} class="rounded-none font-mono">{categoryLabels[escalation.category] ?? escalation.category}</Badge>
							<span class="font-semibold">{escalation.agent}</span>
							<span class="text-dim"><RelativeTime isoTime={escalation.time} {nowMs} /></span>
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
						<div class="flex flex-wrap items-end gap-2">
								<Textarea bind:value={notes[escalation.id]} rows={1} maxlength={noteMaxLength} placeholder="Note (optional)" aria-label={`Note for escalation ${escalation.id}`} class="min-h-8 grow basis-64 font-sans text-[13px]" />
								{#each nextStatuses(escalation) as option (option.status)}
									<Button size="sm" variant={option.status === 'resolved' ? 'default' : 'outline'} disabled={savingEscalation === escalation.id} onclick={() => setEscalationStatus(escalation, option.status)}>{option.label}</Button>
								{/each}
							</div>
					</li>
				{/each}
			</ol>
			{/if}
			{#if escalations.data?.nextCursor}<Button href={nextPageHref(escalations.data.nextCursor)} variant="outline" size="sm" class="self-start">Older escalations</Button>{/if}
		{/if}

		{#if tab === 'checks'}
			<p class="m-0 font-sans text-[13px] text-subheading">Shadow mode: these messages were delivered. The table shows what each rule would have done, so thresholds can be tuned before enforcement.</p>
			<SegmentedLinks links={[outcomeLink('All', undefined), outcomeLink('Would block', 'block'), outcomeLink('Would flag', 'flag'), outcomeLink('Unchecked', 'unchecked')]} label="Rule check outcome" class="self-start" />
			{#if ruleChecks.isPending}
				{@render cardSkeletons()}
			{:else if ruleChecks.isError}
				<ErrorView status={failureStatus(ruleChecks.error)} />
			{:else if ruleChecks.data.items.length === 0}
				<Empty.Root class="border border-dashed">
					<Empty.Header>
						<Empty.Media variant="icon"><ShieldCheckIcon /></Empty.Media>
						<Empty.Title>Nothing would have been blocked or flagged</Empty.Title>
						<Empty.Description>Messages that pass every rule are not listed.</Empty.Description>
					</Empty.Header>
				</Empty.Root>
			{:else}
			<ol class="m-0 flex list-none flex-col gap-3 p-0">
				{#each ruleChecks.data.items as check (check.id)}
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
							<span class="ml-auto text-dim"><RelativeTime isoTime={check.time} {nowMs} /></span>
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
			{/if}
			{#if ruleChecks.data?.nextCursor}<Button href={nextPageHref(ruleChecks.data.nextCursor)} variant="outline" size="sm" class="self-start">Older checks</Button>{/if}
		{/if}

		{#if tab === 'alerts'}
			<p class="m-0 font-sans text-[13px] text-subheading">Each alert goes to Slack.{#if !canAdminister} Only admins can change where.{/if}</p>
			{#if alertRoutes.isPending}
				{@render cardSkeletons()}
			{:else if alertRoutes.isError}
				<ErrorView status={failureStatus(alertRoutes.error)} />
			{:else}
			<Table.Root class="mobile-settings-table">
				<Table.Header>
					<Table.Row>
						<Table.Head class={`${headCell} pl-0`}>Alert</Table.Head>
						<Table.Head class={headCell}>Goes to</Table.Head>
						<Table.Head class={`${headCell} pr-0`}><span class="sr-only">Save</span></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each alertRoutes.data as route (route.event)}
						<Table.Row>
							<Table.Cell data-label="Alert" class="pl-0 align-top whitespace-normal">
								<span class="font-semibold">{alertLabels[route.event].title}</span>
								<span class="block font-sans text-[13px] text-dim">{alertLabels[route.event].detail}</span>
								{#if route.lastFailure}
									<span class="mt-1 block font-sans text-[13px] text-destructive">Last delivery failed <RelativeTime isoTime={route.lastFailure.at} {nowMs} /> to {route.lastFailure.target}: <code class="font-mono">{route.lastFailure.error}</code></span>
								{/if}
							</Table.Cell>
							<Table.Cell data-label="Goes to" class="align-top whitespace-normal">
								<div class="flex flex-wrap items-center gap-2">
									<select
										value={draftFor(route).destination}
										onchange={(event) => editRoute(route, { destination: (event.currentTarget as HTMLSelectElement).value as AlertRoute['destination'] })}
										disabled={!canAdminister}
										aria-label={`Where ${alertLabels[route.event].title} alerts go`}
										class="h-8 w-64 max-w-full border border-input bg-ground px-2 font-mono text-[13px]"
									>
										{#if route.event.startsWith('escalation')}<option value="owner">The agent’s carbon unit (DM)</option>{/if}
										<option value="admins">Admins (DM)</option>
										<option value="channel">A channel</option>
									</select>
									{#if draftFor(route).destination === 'channel'}
										<Input value={draftFor(route).channel ?? ''} oninput={(event) => editRoute(route, { channel: (event.currentTarget as HTMLInputElement).value })} placeholder="#channel" disabled={!canAdminister} aria-label="Channel" class="h-8 w-56 font-mono text-[13px]" />
									{/if}
									<label class="flex items-center gap-1.5 font-sans text-[13px]">
										<input type="checkbox" checked={draftFor(route).enabled} onchange={(event) => editRoute(route, { enabled: (event.currentTarget as HTMLInputElement).checked })} disabled={!canAdminister} class="accent-amber" />
										On
									</label>
								</div>
							</Table.Cell>
							<Table.Cell data-label="Save" class="pr-0 text-right align-top">
								{#if canAdminister}<Button size="sm" variant="outline" disabled={savingRoute === route.event} onclick={() => saveRoute(route)}>Save</Button>{/if}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
			{/if}
		{/if}

		{#if tab === 'rules'}
			<p class="m-0 font-sans text-[13px] text-subheading">Every rule is a yes/no question Jeeves answers for each message. All rules are in shadow mode; editing comes with enforcement.</p>
			{#if rules.isPending}
				{@render cardSkeletons()}
			{:else if rules.isError}
				<ErrorView status={failureStatus(rules.error)} />
			{:else}
			<ol class="m-0 flex list-none flex-col gap-3 p-0">
				{#each rules.data as rule (rule.id)}
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
		{/if}
	</div>
</section>
