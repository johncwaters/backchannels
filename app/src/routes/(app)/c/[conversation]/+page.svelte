<script lang="ts">
	import { conversationHref, conversationQueryPrefix, fileHref, messageHref } from '#lib/admin/helpers.ts';
	import type { Message } from '#lib/admin/types.ts';
	import MessageFeed from '#lib/components/admin/conversation/MessageFeed.svelte';
	import SegmentedLinks from '#lib/components/admin/SegmentedLinks.svelte';
	import ViewHeader from '#lib/components/admin/shell/ViewHeader.svelte';
	import { Input } from '#lib/components/ui/input/index.ts';

	let { data } = $props();

	let shown = $derived(data.shown);
	let conversation = $derived(shown?.conversation);
	let threadParameters: Record<string, string> = $derived(shown?.thread ? { thread: String(shown.thread) } : ({} as Record<string, string>));
	let isChannel = $derived(conversation ? conversation.kind === 'public' || conversation.kind === 'private' : false);

	function hrefHere(conversationId: string, parameters: Record<string, string> = {}): string {
		return conversationHref(conversationId, data.scope, { ...threadParameters, ...parameters });
	}

	let views = $derived(
		shown && conversation && !shown.thread
			? [
					{ label: 'Messages', href: conversationHref(conversation.id, data.scope), isCurrent: !shown.showsPins, navTitle: conversation.name },
					{ label: 'Pinned', count: conversation.pins, href: conversationHref(conversation.id, data.scope, { view: 'pins' }), isCurrent: shown.showsPins, navTitle: conversation.name },
				]
			: [],
	);
</script>

{#if shown && conversation}
	<ViewHeader heading={data.heading} subheading={data.subheading}>
		{#snippet actions()}
			<div class="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-2">
				{#if views.length > 0}<SegmentedLinks links={views} label="Conversation views" />{/if}
				<form action="/search" method="get" role="search" class="relative w-60 max-w-full">
					<input type="hidden" name="scope" value={data.scope} />
					<input type="hidden" name="in" value={conversationQueryPrefix(conversation.id, isChannel)} />
					<span aria-hidden="true" class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-[13px] text-dim">/</span>
					<Input type="search" name="q" aria-label={`Search in ${conversation.name}`} placeholder={`Search in ${conversation.name}`} class="h-7 bg-ground pl-6 font-mono text-[13px]" />
				</form>
			</div>
		{/snippet}
	</ViewHeader>
	{#key shown}
		<MessageFeed
			conversationId={conversation.id}
			conversationName={conversation.name}
			messages={shown.messages}
			nowMs={data.nowMs}
			messageLink={(message: Message) => messageHref(conversation.id, data.scope, message)}
			fileLink={(fileId: string) => fileHref(conversation.id, fileId)}
			olderMessagesHref={(before: number) => hrefHere(conversation.id, { before: String(before) })}
			nextBefore={shown.nextBefore}
			newerMessagesHref={shown.nextAfter ? hrefHere(conversation.id, { after: String(shown.nextAfter) }) : undefined}
			latestMessagesHref={shown.nextAfter ? hrefHere(conversation.id) : undefined}
			backLink={shown.thread ? { href: messageHref(conversation.id, data.scope, { seq: shown.thread, threadRootSeq: null, alsoInChannel: false }), label: `Back to ${conversation.name}`, navTitle: conversation.name } : undefined}
			threadHref={shown.thread ? undefined : (rootSeq: number) => conversationHref(conversation.id, data.scope, { thread: String(rootSeq) })}
			threadRootSeq={shown.thread}
			targetSeq={shown.around}
			showsPins={shown.showsPins}
			readState={shown.showsPins ? undefined : { lastReadSeq: shown.lastReadSeq ?? 0, firstUnreadSeq: shown.firstUnreadSeq }}
		/>
	{/key}
{:else}
	<ViewHeader heading={data.heading} subheading={data.subheading} />
{/if}
