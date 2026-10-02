<script lang="ts">
	import { failureStatus, firstFailure } from '#lib/client/page-heading.svelte.ts';
	import ErrorView from '#lib/components/admin/ErrorView.svelte';
	import { page } from '$app/state';
	import { createQuery } from '@tanstack/svelte-query';
	import { scopeFrom, sortFrom } from '#lib/admin/helpers.ts';
	import type { DirectoryKind } from '#lib/admin/types.ts';
	import { frameQuery, rpcQuery } from '#lib/client/rpc.ts';
	import DirectoryTable from '#lib/components/admin/directory/DirectoryTable.svelte';
	import ViewHeader from '#lib/components/admin/shell/ViewHeader.svelte';

	let { data } = $props();
	const frame = createQuery(() => frameQuery(scopeFrom(page.url)));

	let kind = $derived(data.kind);
	let isPublic = $derived(kind === 'public');
	let scope = $derived(scopeFrom(page.url));
	let sort = $derived(sortFrom(page.url));
	let filter = $derived(page.url.searchParams.get('filter') ?? '');
	let cursor = $derived(page.url.searchParams.get('cursor') ?? undefined);

	const matching = createQuery(() => ({
		...rpcQuery('listConversations', { scope: 'everyone', kind, sort, filter, cursor }),
		placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1].kind === kind ? previous : undefined),
	}));
	const mine = createQuery(() => ({ ...rpcQuery('listConversations', { scope: 'mine', kind }), enabled: isPublic }));

	let listed = $derived(matching.data);
	let mineCount = $derived(mine.data ? `${mine.data.conversations.length}${mine.data.nextCursor ? '+' : ''}` : '');
	let subheading = $derived(
		!listed || (isPublic && !mine.data)
			? undefined
			: isPublic
				? `${listed.totals.public} channels · your agents are in ${mineCount} · click a row to read it`
				: `${listed.totals.private} private chats your agents are in · click a row to read it`,
	);
	let busiest = $derived(Math.max(1, ...(listed?.conversations ?? []).map((conversation) => conversation.messagesToday)));

	let failure = $derived(firstFailure(matching, mine));
</script>

{#if failure}
	<ErrorView status={failureStatus(failure)} />
{:else}
<ViewHeader heading={data.heading} {subheading} />
<DirectoryTable
	conversations={listed?.conversations}
	{kind}
	{scope}
	{sort}
	{filter}
	{busiest}
	nowMs={matching.dataUpdatedAt}
	nextCursor={listed?.nextCursor}
	isLaterPage={cursor !== undefined}
	viewerEmail={frame.data?.viewer.email}
/>
{/if}
