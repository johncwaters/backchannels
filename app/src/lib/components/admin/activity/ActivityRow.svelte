<script lang="ts">
	import type { ActivityEntry } from '#lib/admin/activity.ts';
	import { replaceEmojiShortcodes } from '#lib/admin/emoji.ts';
	import { dayLabel, formatClockTime, messageHref, plainSnippetText } from '#lib/admin/helpers.ts';
	import MessageIdentity from '../conversation/MessageIdentity.svelte';

	let { entry, nowMs }: { entry: ActivityEntry; nowMs: number } = $props();

	const replyLabels = { found: 'Answered', none: 'No answer yet', unknown: 'No answer yet' };
	const replyHints = { found: 'One of your agents replied after this message', none: 'No reply from your agents found yet', unknown: 'No reply from your agents found yet' };
	const linkClass = 'text-amber underline decoration-amber/40 underline-offset-3 hover:decoration-amber max-[899px]:inline-flex max-[899px]:min-h-11 max-[899px]:items-center';

	let message = $derived(entry.match.message);
	let conversation = $derived(entry.match.conversation);
	let reply = $derived(entry.reply);
	let messageTitle = $derived(message.threadRootSeq && !message.alsoInChannel ? `Thread in ${conversation.name}` : conversation.name);
	let replyTitle = $derived(reply?.message.threadRootSeq && !reply.message.alsoInChannel ? `Thread in ${conversation.name}` : conversation.name);
</script>

<article class="flex max-w-[900px] flex-col gap-1.5 border-b border-row-border py-4 first:pt-1">
	<div class="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
		<span class="text-xs text-dim" title={entry.direction === 'post' ? undefined : 'A mention, DM or group chat message to your agents'}>{entry.direction === 'post' ? 'Posted' : 'Incoming'}</span>
		<MessageIdentity {message} class="min-w-0 [overflow-wrap:anywhere]" />
		<time class="ml-auto text-xs whitespace-nowrap text-dim tabular-nums" datetime={message.time}>{dayLabel(message.time, nowMs)} {formatClockTime(message.time)}</time>
	</div>
	<a href={messageHref(conversation.id, 'mine', message)} data-nav-title={messageTitle} class="group flex flex-col gap-1 text-inherit no-underline">
		<span class="text-xs text-dim">in <span class="text-subheading group-hover:text-amber">{conversation.name}</span></span>
		<p class="m-0 line-clamp-4 font-sans text-[15px] leading-normal text-message group-hover:text-foreground">{plainSnippetText(replaceEmojiShortcodes(message.text))}</p>
	</a>
	{#if entry.direction === 'incoming' && entry.replyCheck}
		<div class="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-xs">
			<span class={entry.replyCheck === 'found' ? 'text-agent-codex' : 'text-dim'} title={replyHints[entry.replyCheck]}>{replyLabels[entry.replyCheck]}</span>
			{#if reply}<a class={linkClass} href={messageHref(conversation.id, 'mine', reply.message)} data-nav-title={replyTitle}>Read {reply.message.person}/{reply.message.agent}'s reply</a>{/if}
		</div>
	{/if}
</article>
