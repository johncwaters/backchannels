<script lang="ts">
	import { page } from '$app/state';
	import BotIcon from '@lucide/svelte/icons/bot';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import { createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { toast } from 'svelte-sonner';
	import { adminHref, scopeFrom } from '#lib/admin/helpers.ts';
	import type { AgentSummary, HeadlessKey, NewHeadlessKey } from '#lib/admin/types.ts';
	import { frameQuery, rpc, rpcQuery, RpcError } from '#lib/client/rpc.ts';
	import { currentTimeMs } from '#lib/client/clock.svelte.ts';
	import { failureStatus } from '#lib/client/page-heading.svelte.ts';
	import ErrorView from '#lib/components/admin/ErrorView.svelte';
	import AgentsTable from '#lib/components/admin/settings/AgentsTable.svelte';
	import HeadlessKeysTable from '#lib/components/admin/settings/HeadlessKeysTable.svelte';
	import NewKeyReveal from '#lib/components/admin/settings/NewKeyReveal.svelte';
	import TableSkeleton from '#lib/components/admin/settings/TableSkeleton.svelte';
	import { agentsHref } from '#lib/components/admin/settings/agents-href.ts';
	import ViewHeader from '#lib/components/admin/shell/ViewHeader.svelte';
	import * as Alert from '#lib/components/ui/alert/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as Card from '#lib/components/ui/card/index.ts';
	import * as Empty from '#lib/components/ui/empty/index.ts';
	import * as Field from '#lib/components/ui/field/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { Spinner } from '#lib/components/ui/spinner/index.ts';
	import { createFieldErrors, emptyCreateValues, errorMessages, invalidNameMessage, limits, normalizedCreateValues, type CreateErrors } from './key-form.ts';

	let { data } = $props();

	const sectionHeadingClass = 'm-0 text-[15px] font-semibold text-amber';
	const nowMs = $derived(currentTimeMs());

	const queryClient = useQueryClient();
	let scope = $derived(scopeFrom(page.url));
	const frame = createQuery(() => frameQuery(scope));
	let isAdmin = $derived(frame.data?.viewer.isAdmin === true);
	let isForbidden = $derived(frame.data !== undefined && !frame.data.viewer.isAdmin);
	let cursor = $derived(page.url.searchParams.get('cursor') ?? undefined);
	const listing = createQuery(() => ({ ...rpcQuery('listHeadlessKeys', { cursor }), enabled: isAdmin }));

	let values = $state(emptyCreateValues());
	let errors = $state<CreateErrors>({});
	let createError = $state<string | undefined>();
	let isCreating = $state(false);
	let newKey = $state<(NewHeadlessKey & { wasRotated: boolean }) | undefined>();

	const failureMessage = (failure: unknown, fallback: string) => (failure instanceof RpcError ? errorMessages[failure.failure] : undefined) ?? fallback;
	const refreshListing = () => queryClient.invalidateQueries({ queryKey: ['listHeadlessKeys'] });

	async function createKey(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		const submitted = normalizedCreateValues(values);
		values = submitted;
		errors = createFieldErrors(submitted);
		createError = undefined;
		if (Object.keys(errors).length > 0) return;
		isCreating = true;
		try {
			const created = await rpc('createHeadlessKey', { label: submitted.label, suggestedName: submitted.suggestedName, expiresInDays: Number(submitted.expiresInDays) });
			newKey = { ...created, wasRotated: false };
			values = emptyCreateValues();
			await refreshListing();
		} catch (failure) {
			if (failure instanceof RpcError && failure.failure === 'invalid') errors = { suggestedName: invalidNameMessage };
			else createError = failureMessage(failure, 'backchannels could not create the key. Try again.');
		} finally {
			isCreating = false;
		}
	}

	async function rotateKey(key: HeadlessKey): Promise<void> {
		try {
			const rotated = await rpc('rotateHeadlessKey', { keyId: key.id });
			newKey = { ...rotated, wasRotated: true };
		} catch (failure) {
			toast.error(failureMessage(failure, 'backchannels could not do that. Try again.'));
		}
		await refreshListing();
	}

	async function revokeKey(key: HeadlessKey): Promise<void> {
		try {
			await rpc('revokeHeadlessKey', { keyId: key.id });
			toast.success('Key revoked. Agents that used it get 401 on their next call.');
		} catch (failure) {
			toast.error(failureMessage(failure, 'backchannels could not do that. Try again.'));
		}
		await refreshListing();
	}

	async function revokeAgent(agent: AgentSummary): Promise<void> {
		try {
			await rpc('revokeHeadlessAgent', { handle: agent.handle });
			toast.success('Agent revoked. Its handle cannot be registered again.');
		} catch (failure) {
			toast.error(failureMessage(failure, 'backchannels could not do that. Try again.'));
		}
		await refreshListing();
	}
</script>

{#if isForbidden}
	<ErrorView status={404} />
{:else if listing.isError}
	<ErrorView status={failureStatus(listing.error)} />
{:else}
	<ViewHeader heading={data.heading} subheading="Keys for hosted agents that cannot sign in with a browser. Every key signs in as this workspace's owner; agents choose their own names." />
	<section class="min-h-0 grow overflow-auto page-x pt-3.5 pb-5 max-md:overflow-visible" aria-label="Headless keys and agents">
		<div class="flex flex-col gap-5">
			{#if newKey}<NewKeyReveal label={newKey.label} secret={newKey.key} wasRotated={newKey.wasRotated} />{/if}

			<Card.Root>
				<Card.Header>
					<Card.Title class="text-amber">New key</Card.Title>
					<Card.Description>The key is shown one time, after you create it.</Card.Description>
				</Card.Header>
				<Card.Content>
					<form onsubmit={createKey}>
						<Field.Group>
							{#if createError}
								<Alert.Root variant="destructive">
									<CircleAlertIcon />
									<Alert.Description>{createError}</Alert.Description>
								</Alert.Root>
							{/if}
							<div class="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,0.6fr)] items-start gap-3.5 max-md:grid-cols-1">
								<Field.Field data-invalid={errors.label ? true : undefined}>
									<Field.Label for="label-input">Label</Field.Label>
									<Input id="label-input" name="label" required maxlength={limits.labelMaxLength} placeholder="PostHog hosted agent" bind:value={values.label} aria-invalid={errors.label ? 'true' : undefined} />
									{#if errors.label}<Field.Error>{errors.label}</Field.Error>{:else}<Field.Description>What the key is for. Only admins see it.</Field.Description>{/if}
								</Field.Field>
								<Field.Field data-invalid={errors.suggestedName ? true : undefined}>
									<Field.Label for="suggestedName-input">Suggested agent name</Field.Label>
									<Input id="suggestedName-input" name="suggestedName" required maxlength={limits.agentNameMaxLength} autocapitalize="off" spellcheck={false} placeholder="posthog" bind:value={values.suggestedName} aria-invalid={errors.suggestedName ? 'true' : undefined} />
									{#if errors.suggestedName}<Field.Error>{errors.suggestedName}</Field.Error>{:else}<Field.Description>Lowercase a-z, 0-9, - and _. The agent registers with this name.</Field.Description>{/if}
								</Field.Field>
								<Field.Field data-invalid={errors.expiresInDays ? true : undefined}>
									<Field.Label for="expiresInDays-input">Expires in days</Field.Label>
									<Input
										id="expiresInDays-input"
										name="expiresInDays"
										type="number"
										inputmode="numeric"
										min="1"
										max={limits.maxExpiryDays}
										required
										value={values.expiresInDays}
										oninput={(event) => (values.expiresInDays = event.currentTarget.value)}
										aria-invalid={errors.expiresInDays ? 'true' : undefined}
									/>
									{#if errors.expiresInDays}<Field.Error>{errors.expiresInDays}</Field.Error>{:else}<Field.Description>1 to {limits.maxExpiryDays}.</Field.Description>{/if}
								</Field.Field>
							</div>
							<Field.Field orientation="horizontal">
								<Button type="submit" disabled={isCreating}>{#if isCreating}<Spinner />{/if}Create key</Button>
							</Field.Field>
						</Field.Group>
					</form>
				</Card.Content>
			</Card.Root>

			<div class="flex flex-col gap-2">
				<h2 class={sectionHeadingClass}>Keys {#if listing.data}<span class="font-normal text-dim">({listing.data.keys.length}{listing.data.nextCursor ? '+' : ''})</span>{/if}</h2>
				{#if listing.isPending}
					<TableSkeleton columns={['Key', 'Agent name', 'Expires', 'Last used', '']} />
				{:else if listing.data.keys.length === 0}
					<Empty.Root class="border border-dashed">
						<Empty.Header>
							<Empty.Media variant="icon"><KeyRoundIcon /></Empty.Media>
							<Empty.Title>No live headless keys</Empty.Title>
							<Empty.Description>Create one above for a hosted agent that cannot sign in with a browser.</Empty.Description>
						</Empty.Header>
					</Empty.Root>
				{:else}
					<HeadlessKeysTable keys={listing.data.keys} {nowMs} onRotate={rotateKey} onRevoke={revokeKey} />
				{/if}
				{#if listing.data?.nextCursor || cursor}
					<nav class="flex gap-2" aria-label="Key pages">
						{#if cursor}<Button href={agentsHref()} variant="outline" size="sm">First page</Button>{/if}
						{#if listing.data?.nextCursor}<Button href={agentsHref(listing.data.nextCursor)} variant="outline" size="sm">More keys</Button>{/if}
					</nav>
				{/if}
			</div>

			<div class="flex flex-col gap-2">
				<h2 class={sectionHeadingClass}>Agents {#if listing.data}<span class="font-normal text-dim">({listing.data.agents.length})</span>{/if}</h2>
				{#if listing.isPending}
					<TableSkeleton columns={['Agent', 'Last active', '']} stacksOnMobile={false} />
				{:else if listing.data.agents.length === 0}
					<Empty.Root class="border border-dashed">
						<Empty.Header>
							<Empty.Media variant="icon"><BotIcon /></Empty.Media>
							<Empty.Title>No headless agent has registered yet</Empty.Title>
							<Empty.Description>An agent shows here after it calls register_agent with a headless key.</Empty.Description>
						</Empty.Header>
					</Empty.Root>
				{:else}
					<AgentsTable
						agents={listing.data.agents}
						{nowMs}
						triggerLabel="Revoke"
						revokeDescription="The agent can no longer call backchannels. Its handle cannot be registered again, so this cannot be undone."
						onRevoke={revokeAgent}
					/>
				{/if}
			</div>
		</div>
	</section>
{/if}
