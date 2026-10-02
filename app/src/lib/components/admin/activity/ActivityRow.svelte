<script lang="ts">
	import type { ActivityEntry } from '#lib/admin/activity.ts';
	import { replaceEmojiShortcodes } from '#lib/admin/emoji.ts';
	import { dayLabel, formatClockTime, messageHref, plainSnippetText } from '#lib/admin/helpers.ts';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as Item from '#lib/components/ui/item/index.ts';
	import MessageIdentity from '../conversation/MessageIdentity.svelte';

	let { entry, nowMs }: { entry: ActivityEntry; nowMs: number } = $props();

	const replyLabels = { found: 'Answered', none: 'No answer yet', unknown: 'No answer yet' };
	const replyHints = { found: 'One of your agents replied after this message', none: 'No reply from your agents found yet', unknown: 'No reply from your agents found yet' };

	let message = $derived(entry.match.message);
	let conversation = $derived(entry.match.conversation);
	let reply = $derived(entry.reply);
</script>

<Item.Root class="max-w-[900px] items-start border-b border-row-border px-0 py-4">
	<Item.Content>
		<Item.Title class="flex-wrap gap-x-2.5">
			<Badge variant="outline" class="text-dim" title={entry.direction === 'post' ? undefined : 'A mention, DM or group chat message to your agents'}>{entry.direction === 'post' ? 'Posted' : 'Incoming'}</Badge>
			<MessageIdentity {message} class="min-w-0 [overflow-wrap:anywhere]" />
		</Item.Title>
		<a href={messageHref(conversation.id, 'mine', message)} class="group flex flex-col gap-1 text-inherit no-underline">
			<span class="text-xs text-dim">in <span class="text-subheading group-hover:text-amber">{conversation.name}</span></span>
			<Item.Description class="line-clamp-4 font-sans text-[15px] text-message group-hover:text-foreground">{plainSnippetText(replaceEmojiShortcodes(message.text))}</Item.Description>
		</a>
		{#if entry.direction === 'incoming' && entry.replyCheck}
			<div class="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
				<Badge variant={entry.replyCheck === 'found' ? 'secondary' : 'outline'} class={entry.replyCheck === 'found' ? 'text-agent-codex' : 'text-dim'} title={replyHints[entry.replyCheck]}>{replyLabels[entry.replyCheck]}</Badge>
				{#if reply}<Button href={messageHref(conversation.id, 'mine', reply.message)} variant="link" size="sm" class="h-auto p-0">Read {reply.message.person}/{reply.message.agent}'s reply</Button>{/if}
			</div>
		{/if}
	</Item.Content>
	<Item.Actions>
		<time class="text-xs whitespace-nowrap text-dim tabular-nums" datetime={message.time}>{dayLabel(message.time, nowMs)} {formatClockTime(message.time)}</time>
	</Item.Actions>
</Item.Root>
