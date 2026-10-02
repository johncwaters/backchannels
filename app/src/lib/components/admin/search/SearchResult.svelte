<script lang="ts">
	import { dayLabel, formatClockTime, highlightSegments, messageHref, plainSnippetText, replyCountLabel, snippetAround } from '#lib/admin/helpers.ts';
	import { searchEmojiText } from '#lib/admin/emoji.ts';
	import type { Scope, SearchMatch } from '#lib/admin/types.ts';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import MessageIdentity from '../conversation/MessageIdentity.svelte';

	let { match, scope, nowMs }: { match: SearchMatch; scope: Scope; nowMs: number } = $props();

	const markerClass = 'h-auto rounded-none px-1.5 py-0 font-mono text-xs font-normal';
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

<a
	class="group flex max-w-[800px] flex-col gap-1 border-l-2 border-transparent bg-search-match px-3 py-2 text-inherit no-underline outline-none hover:border-amber hover:bg-secondary focus-visible:border-amber focus-visible:bg-secondary focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-amber"
	href={messageHref(conversation.id, scope, message)}
	data-nav-title={message.threadRootSeq && !message.alsoInChannel ? `Thread in ${conversation.name}` : conversation.name}
>
	<span class="flex flex-wrap items-baseline gap-x-2.5">
		<MessageIdentity {message} />
		<span class="max-w-[42ch] min-w-0 truncate text-[13px] text-dim">in <span class="text-foreground">{conversation.name}</span></span>
		{#if threadNote}<Badge variant="outline" class={`${markerClass} text-muted-foreground`}>{threadNote}</Badge>{/if}
		{#if message.pinned}<Badge variant="outline" class={`${markerClass} border-amber text-amber`}>pinned</Badge>{/if}
		{#if fileNote}<Badge variant="outline" class={`${markerClass} text-muted-foreground`}>{fileNote}</Badge>{/if}
		<time class="ml-auto text-[13px] text-dim" datetime={message.time}>{dayLabel(message.time, nowMs)} {formatClockTime(message.time)}</time>
	</span>
	<span class="line-clamp-3 font-sans text-sm leading-normal text-message"
		>{#each segments as segment, index (index)}{#if segment.isMatch && segment.text.trim()}<mark class="bg-amber px-0.5 text-ground">{segment.text}</mark>{:else}{segment.text}{/if}{/each}</span
	>
</a>
