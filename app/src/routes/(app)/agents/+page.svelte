<script lang="ts">
	import { enhance } from '$app/forms';
	import BotIcon from '@lucide/svelte/icons/bot';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import AgentsTable from '#lib/components/admin/settings/AgentsTable.svelte';
	import HeadlessKeysTable from '#lib/components/admin/settings/HeadlessKeysTable.svelte';
	import NewKeyReveal from '#lib/components/admin/settings/NewKeyReveal.svelte';
	import { agentsHref } from '#lib/components/admin/settings/agents-href.ts';
	import ViewHeader from '#lib/components/admin/shell/ViewHeader.svelte';
	import * as Alert from '#lib/components/ui/alert/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as Card from '#lib/components/ui/card/index.ts';
	import * as Empty from '#lib/components/ui/empty/index.ts';
	import * as Field from '#lib/components/ui/field/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { Spinner } from '#lib/components/ui/spinner/index.ts';

	let { data, form } = $props();

	type CreateField = 'label' | 'suggestedName' | 'expiresInDays';

	const sectionHeadingClass = 'm-0 text-[15px] font-semibold text-amber';

	let values = $derived(form && 'values' in form && form.values ? form.values : { label: '', suggestedName: '', expiresInDays: String(data.limits.maxExpiryDays) });
	let errors: Partial<Record<CreateField, string>> = $derived(form && 'errors' in form && form.errors ? form.errors : {});
	let newKey = $derived(form && 'newKey' in form ? form.newKey : undefined);
	let createError = $derived(form && 'values' in form && 'error' in form ? form.error : undefined);
	let isCreating = $state(false);
</script>

<ViewHeader heading={data.heading} subheading="Keys for hosted agents that cannot sign in with a browser. Every key signs in as this workspace's owner; agents choose their own names." />
<section class="min-h-0 grow overflow-auto px-7 pt-3.5 pb-5 max-md:overflow-visible max-md:px-4" aria-label="Headless keys and agents">
	<div class="flex max-w-[960px] flex-col gap-5">
		{#if newKey}<NewKeyReveal label={newKey.label} secret={newKey.key} wasRotated={newKey.wasRotated} />{/if}

		<Card.Root>
			<Card.Header>
				<Card.Title class="text-amber">New key</Card.Title>
				<Card.Description>The key is shown one time, after you create it.</Card.Description>
			</Card.Header>
			<Card.Content>
				<form
					method="post"
					action="?/create"
					use:enhance={() => {
						isCreating = true;
						return async ({ update }) => {
							await update({ reset: false });
							isCreating = false;
						};
					}}
				>
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
								<Input id="label-input" name="label" required maxlength={data.limits.labelMaxLength} placeholder="PostHog hosted agent" value={values.label} aria-invalid={errors.label ? 'true' : undefined} />
								{#if errors.label}<Field.Error>{errors.label}</Field.Error>{:else}<Field.Description>What the key is for. Only admins see it.</Field.Description>{/if}
							</Field.Field>
							<Field.Field data-invalid={errors.suggestedName ? true : undefined}>
								<Field.Label for="suggestedName-input">Suggested agent name</Field.Label>
								<Input id="suggestedName-input" name="suggestedName" required maxlength={data.limits.agentNameMaxLength} autocapitalize="off" spellcheck={false} placeholder="posthog" value={values.suggestedName} aria-invalid={errors.suggestedName ? 'true' : undefined} />
								{#if errors.suggestedName}<Field.Error>{errors.suggestedName}</Field.Error>{:else}<Field.Description>Lowercase a-z, 0-9, - and _. The agent registers with this name.</Field.Description>{/if}
							</Field.Field>
							<Field.Field data-invalid={errors.expiresInDays ? true : undefined}>
								<Field.Label for="expiresInDays-input">Expires in days</Field.Label>
								<Input id="expiresInDays-input" name="expiresInDays" type="number" inputmode="numeric" min="1" max={data.limits.maxExpiryDays} required value={values.expiresInDays} aria-invalid={errors.expiresInDays ? 'true' : undefined} />
								{#if errors.expiresInDays}<Field.Error>{errors.expiresInDays}</Field.Error>{:else}<Field.Description>1 to {data.limits.maxExpiryDays}.</Field.Description>{/if}
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
			<h2 class={sectionHeadingClass}>Keys <span class="font-normal text-dim">({data.keys.length}{data.nextCursor ? '+' : ''})</span></h2>
			{#if data.keys.length === 0}
				<Empty.Root class="border border-dashed">
					<Empty.Header>
						<Empty.Media variant="icon"><KeyRoundIcon /></Empty.Media>
						<Empty.Title>No live headless keys</Empty.Title>
						<Empty.Description>Create one above for a hosted agent that cannot sign in with a browser.</Empty.Description>
					</Empty.Header>
				</Empty.Root>
			{:else}
				<HeadlessKeysTable keys={data.keys} nowMs={data.nowMs} />
			{/if}
			{#if data.nextCursor || data.cursor}
				<nav class="flex gap-2" aria-label="Key pages">
					{#if data.cursor}<Button href={agentsHref()} variant="outline" size="sm">First page</Button>{/if}
					{#if data.nextCursor}<Button href={agentsHref(data.nextCursor)} variant="outline" size="sm">More keys</Button>{/if}
				</nav>
			{/if}
		</div>

		<div class="flex flex-col gap-2">
			<h2 class={sectionHeadingClass}>Agents <span class="font-normal text-dim">({data.agents.length})</span></h2>
			{#if data.agents.length === 0}
				<Empty.Root class="border border-dashed">
					<Empty.Header>
						<Empty.Media variant="icon"><BotIcon /></Empty.Media>
						<Empty.Title>No headless agent has registered yet</Empty.Title>
						<Empty.Description>An agent shows here after it calls register_agent with a headless key.</Empty.Description>
					</Empty.Header>
				</Empty.Root>
			{:else}
				<AgentsTable
					agents={data.agents}
					nowMs={data.nowMs}
					triggerLabel="Revoke"
					revokeDescription="The agent can no longer call backchannels. Its handle cannot be registered again, so this cannot be undone."
				/>
			{/if}
		</div>
	</div>
</section>
