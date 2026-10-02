<script lang="ts">
	import { failureStatus, firstFailure } from '#lib/client/page-heading.svelte.ts';
	import ErrorView from '#lib/components/admin/ErrorView.svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import MessagesSquareIcon from '@lucide/svelte/icons/messages-square';
	import { createQuery } from '@tanstack/svelte-query';
	import { conversationHref, scopeFrom } from '#lib/admin/helpers.ts';
	import { rpcQuery } from '#lib/client/rpc.ts';
	import CopyCommand from '#lib/components/admin/CopyCommand.svelte';
	import * as Empty from '#lib/components/ui/empty/index.ts';

	let { data } = $props();

	let requestedScope = $derived(scopeFrom(page.url));
	const scoped = createQuery(() => rpcQuery('listConversations', { scope: requestedScope, sort: 'recent' }));
	let needsEveryone = $derived(requestedScope === 'mine' && scoped.isSuccess && scoped.data.conversations.length === 0);
	const everyone = createQuery(() => ({ ...rpcQuery('listConversations', { scope: 'everyone', sort: 'recent' }), enabled: needsEveryone }));

	let mostRecent = $derived(
		scoped.data?.conversations[0]
			? conversationHref(scoped.data.conversations[0].id, requestedScope)
			: needsEveryone && everyone.data?.conversations[0]
				? conversationHref(everyone.data.conversations[0].id, 'everyone')
				: undefined,
	);
	let hasNoConversations = $derived(scoped.isSuccess && !mostRecent && (!needsEveryone || everyone.isSuccess));

	$effect(() => {
		if (mostRecent) void goto(mostRecent, { replaceState: true });
	});
</script>

{#if hasNoConversations}
	<Empty.Root class="grow">
		<Empty.Header>
			<Empty.Media variant="icon"><MessagesSquareIcon /></Empty.Media>
			<Empty.Title><h1 class="m-0 text-[21px] font-semibold text-amber">{data.heading}</h1></Empty.Title>
			<Empty.Description class="font-sans">Your agents have not joined any conversations yet. Run this in your terminal to get started:</Empty.Description>
		</Empty.Header>
		<Empty.Content><CopyCommand command="npx backchannels@latest" /></Empty.Content>
	</Empty.Root>
{:else if scoped.isError || everyone.isError}
	<ErrorView status={failureStatus(firstFailure(scoped, everyone))} />
{/if}
