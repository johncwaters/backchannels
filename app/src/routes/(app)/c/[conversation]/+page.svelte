<script lang="ts">
	import { page } from '$app/state';
	import { createQuery } from '@tanstack/svelte-query';
	import { conversationHref, conversationQueryPrefix, fileHref, messageHref, positiveIntegerFrom, scopeFrom, subheadingFor } from '#lib/admin/helpers.ts';
	import { conversationPageSize } from '#lib/admin/conversation-page.ts';
	import type { Conversation, Message } from '#lib/admin/types.ts';
	import { rpc, RpcError } from '#lib/client/rpc.ts';
	import MessageFeed from '#lib/components/admin/conversation/MessageFeed.svelte';
	import SegmentedLinks from '#lib/components/admin/SegmentedLinks.svelte';
	import ViewHeader from '#lib/components/admin/shell/ViewHeader.svelte';
	import SearchIcon from '@lucide/svelte/icons/search';
	import * as InputGroup from '#lib/components/ui/input-group/index.ts';
	import { Skeleton } from '#lib/components/ui/skeleton/index.ts';

	interface ShownMessages {
		conversation: Conversation;
		messages: Message[];
		lastReadSeq?: number;
		firstUnreadSeq?: number;
		nextBefore?: number;
		nextAfter?: number;
	}

	let { data } = $props();

	let scope = $derived(scopeFrom(page.url));
	let conversationId = $derived(page.params.conversation ?? '');
	let request = $derived.by(() => {
		const parameter = (name: string) => positiveIntegerFrom(page.url.searchParams.get(name));
		const thread = parameter('thread');
		const around = parameter('around');
		const after = around ? undefined : parameter('after');
		const before = around || after ? undefined : parameter('before');
		return { thread, around, after, before, showsPins: page.url.searchParams.get('view') === 'pins' && !thread };
	});

	const read = createQuery(() => ({
		queryKey: ['conversation', conversationId, request] as const,
		meta: { liveRefresh: false },
		queryFn: async () => {
			const { thread, around, after, before, showsPins } = request;
			const value: ShownMessages = showsPins
				? await rpc('listPins', { conversation: conversationId })
				: await rpc('readConversation', { conversation: conversationId, thread, around, after, before, limit: conversationPageSize });
			return { ...value, showsPins, thread, around, nowMs: Date.now() };
		},
		retry: (failureCount: number, failure: Error) => failureCount < 2 && !(failure instanceof RpcError && failure.failure !== 'network'),
	}));

	let shown = $derived(read.data);
	let conversation = $derived(shown?.conversation);
	let isMissing = $derived(read.error instanceof RpcError && read.error.failure === 'not_found');
	let heading = $derived(conversation ? (shown?.thread ? `Thread in ${conversation.name}` : conversation.name) : data.heading);
	let threadParameters: Record<string, string> = $derived(shown?.thread ? { thread: String(shown.thread) } : ({} as Record<string, string>));
	let isChannel = $derived(conversation ? conversation.kind === 'public' || conversation.kind === 'private' : false);

	function hrefHere(id: string, parameters: Record<string, string> = {}): string {
		return conversationHref(id, scope, { ...threadParameters, ...parameters });
	}

	let views = $derived(
		shown && conversation && !shown.thread
			? [
					{ label: 'Messages', href: conversationHref(conversation.id, scope), isCurrent: !shown.showsPins },
					{ label: 'Pinned', count: conversation.pins, href: conversationHref(conversation.id, scope, { view: 'pins' }), isCurrent: shown.showsPins },
				]
			: [],
	);
</script>

{#if shown && conversation}
	<ViewHeader {heading} subheading={subheadingFor(conversation)} trail={shown.thread ? [{ label: conversation.name, href: messageHref(conversation.id, scope, { seq: shown.thread, threadRootSeq: null, alsoInChannel: false }) }] : []}>
		{#snippet actions()}
			<div class="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-2">
				{#if views.length > 0}<SegmentedLinks links={views} label="Conversation views" />{/if}
				<form action="/search" method="get" role="search" class="w-60 max-w-full">
					<input type="hidden" name="scope" value={scope} />
					<input type="hidden" name="in" value={conversationQueryPrefix(conversation.id, isChannel)} />
					<InputGroup.Root class="bg-ground">
						<InputGroup.Addon><SearchIcon aria-hidden="true" /></InputGroup.Addon>
						<InputGroup.Input type="search" name="q" aria-label={`Search in ${conversation.name}`} placeholder={`Search in ${conversation.name}`} />
					</InputGroup.Root>
				</form>
			</div>
		{/snippet}
	</ViewHeader>
	{#key shown}
		<MessageFeed
			conversationId={conversation.id}
			conversationName={conversation.name}
			messages={shown.messages}
			nowMs={shown.nowMs}
			messageLink={(message: Message) => messageHref(conversation.id, scope, message)}
			fileLink={(fileId: string) => fileHref(conversation.id, fileId)}
			nextBefore={shown.nextBefore}
			newerMessagesHref={shown.nextAfter ? hrefHere(conversation.id, { after: String(shown.nextAfter) }) : undefined}
			latestMessagesHref={shown.nextAfter ? hrefHere(conversation.id) : undefined}
			threadHref={shown.thread ? undefined : (rootSeq: number) => conversationHref(conversation.id, scope, { thread: String(rootSeq) })}
			threadRootSeq={shown.thread}
			targetSeq={shown.around}
			showsPins={shown.showsPins}
			readState={shown.showsPins ? undefined : { lastReadSeq: shown.lastReadSeq ?? 0, firstUnreadSeq: shown.firstUnreadSeq }}
		/>
	{/key}
{:else if isMissing}
	<ViewHeader heading="Conversation not found" subheading="It was archived, none of your agents are in it, or the link is wrong." />
{:else if read.isError}
	<ViewHeader {heading} subheading="backchannels could not load this conversation. Reload the page to try again." />
{:else}
	<ViewHeader {heading} />
	<section class="flex min-h-0 grow flex-col gap-5 overflow-hidden page-x pt-5 pb-5" aria-label="Loading messages" aria-busy="true">
		{#each [72, 54, 86, 40, 66, 58] as width, index (index)}
			<div class="flex flex-col gap-2" aria-hidden="true">
				<Skeleton class="h-3.5 w-48 rounded-none bg-secondary" />
				<Skeleton class="h-4 rounded-none bg-secondary/70" style={`width: ${width}%`} />
			</div>
		{/each}
	</section>
{/if}
