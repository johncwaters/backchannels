<script lang="ts">
	import { dayLabel, formatClockTime, highlightSegments, messageHref, plainSnippetText, replyCountLabel, snippetAround } from '#lib/admin/helpers.ts';
	import { searchEmojiText } from '#lib/admin/emoji.ts';
	import type { Scope, SearchMatch } from '#lib/admin/types.ts';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import * as Item from '#lib/components/ui/item/index.ts';
	import MessageIdentity from '../conversation/MessageIdentity.svelte';

	let { match, scope, nowMs }: { match: SearchMatch; scope: Scope; nowMs: number } = $props();

	let message = $derived(match.message);
	let conversation = $derived(match.conversation);
	let segments = $derived.by(() => {
		const converted = searchEmojiText(message.text, match.ranges);
		const snippet = snippetAround(plainSnippetText(converted.text), converted.ranges);
		return highlightSegments(snippet.text, snippet.ranges);
	});
	let threadNote = $derived(message.threadRootSeq ? 'reply in a thread' : message.threadReplies > 0 ? replyCountLabel(message.threadReplies) : null);
	let fileNote = $derived(message.files.length === 0 ? null : message.files.length === 1 ? '1 file' : `${message.files.length} files`);
</script>

<Item.Root variant="muted" class="relative max-w-[800px] border-l-2 border-l-transparent hover:border-l-amber hover:bg-muted has-[a[data-result-link]:focus-visible]:border-ring has-[a[data-result-link]:focus-visible]:ring-[3px] has-[a[data-result-link]:focus-visible]:ring-ring/50">
	<Item.Content>
		<Item.Title class="flex-wrap gap-x-2.5">
			<MessageIdentity {message} />
			<span class="max-w-[42ch] min-w-0 truncate font-normal text-dim">in <span class="text-foreground">{conversation.name}</span></span>
			{#if threadNote}<Badge variant="outline">{threadNote}</Badge>{/if}
			{#if message.pinned}<Badge variant="outline" class="border-amber text-amber">pinned</Badge>{/if}
			{#if fileNote}<Badge variant="outline">{fileNote}</Badge>{/if}
		</Item.Title>
		<a href={messageHref(conversation.id, scope, message)} data-result-link class="text-inherit no-underline outline-none after:absolute after:inset-0">
			<Item.Description class="line-clamp-3 font-sans text-sm text-message"
				>{#each segments as segment, index (index)}{#if segment.isMatch && segment.text.trim()}<mark class="bg-amber px-0.5 text-ground">{segment.text}</mark>{:else}{segment.text}{/if}{/each}</Item.Description
			>
		</a>
	</Item.Content>
	<Item.Actions class="self-start">
		<time class="text-[13px] whitespace-nowrap text-dim" datetime={message.time}>{dayLabel(message.time, nowMs)} {formatClockTime(message.time)}</time>
	</Item.Actions>
</Item.Root>
