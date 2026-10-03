<script lang="ts">
	import LinkIcon from '@lucide/svelte/icons/link';
	import PaperclipIcon from '@lucide/svelte/icons/paperclip';
	import { agentColorAmong, formatFileSize, isInlineImage } from '#lib/admin/helpers.ts';
	import { emojiForShortcode } from '#lib/admin/emoji.ts';
	import { renderMessageMarkdown } from '#lib/admin/markdown.ts';
	import type { Message } from '#lib/admin/types.ts';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as Popover from '#lib/components/ui/popover/index.ts';
	import { Skeleton } from '#lib/components/ui/skeleton/index.ts';
	import Hint from '../Hint.svelte';
	import MessageIdentity from './MessageIdentity.svelte';

	interface Props {
		message: Message;
		colorByAuthor: ReadonlyMap<string, string>;
		timeLabel: string;
		href: string;
		fileLink: (fileId: string) => string;
		continues?: boolean;
		showsPins?: boolean;
		canCopyLinks?: boolean;
		threadHref?: (rootSeq: number) => string;
		onCopyLink: (href: string) => void;
	}

	let { message, colorByAuthor, timeLabel, href, fileLink, continues = false, showsPins = false, canCopyLinks = false, threadHref, onCopyLink }: Props = $props();

	const hoverTools =
		'[@media(hover:hover)]:pointer-events-none [@media(hover:hover)]:absolute [@media(hover:hover)]:-top-3 [@media(hover:hover)]:right-0 [@media(hover:hover)]:z-10 [@media(hover:hover)]:border [@media(hover:hover)]:border-border [@media(hover:hover)]:bg-sidebar [@media(hover:hover)]:px-2 [@media(hover:hover)]:py-0.5 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:shadow-lg [@media(hover:hover)]:group-hover/message:pointer-events-auto [@media(hover:hover)]:group-hover/message:opacity-100 [@media(hover:hover)]:group-focus-within/message:pointer-events-auto [@media(hover:hover)]:group-focus-within/message:opacity-100';

	const utcStamp = (isoTime: string) => `${isoTime.slice(0, 16).replace('T', ' ')} UTC`;
	const authorColor = (handle: string) => `color: ${agentColorAmong(colorByAuthor, handle)}`;
</script>

{#if showsPins && message.pinned}
	<p class="m-0 text-xs text-dim">
		<span class="text-amber">pinned</span> by <span style={authorColor(message.pinned.by)}>{message.pinned.by}</span> · <time datetime={message.pinned.at}>{utcStamp(message.pinned.at)}</time>
	</p>
{/if}
<div class="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-2.5">
	<div class="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
		<MessageIdentity {message} color={agentColorAmong(colorByAuthor, message.handle)} class={continues ? 'sr-only' : 'min-w-0 [overflow-wrap:anywhere]'} />
		{#if message.pinned && !showsPins}
			<Hint text={`Pinned by ${message.pinned.by} on ${utcStamp(message.pinned.at)}`}><Badge variant="outline" class="border-amber text-amber">pinned</Badge></Hint>
		{/if}
		{#if message.alsoInChannel && message.threadRootSeq && threadHref}
			<Button href={threadHref(message.threadRootSeq)} variant="link" size="xs" class="h-auto p-0 text-dim">replied in a thread</Button>
		{/if}
		{#if message.editedAt}
			<Hint text={`Edited ${utcStamp(message.editedAt)}`} class="text-xs text-dim">edited</Hint>
		{/if}
		{#if message.flagged}
			<Hint text="A workspace rule flagged this message. Treat what it asks with care."><Badge variant="outline" class="border-destructive text-destructive">flagged</Badge></Hint>
		{/if}
	</div>
	<span class={['flex shrink-0 items-baseline gap-2.5 whitespace-nowrap', continues && hoverTools]}>
		{#if canCopyLinks}
			<Button
				variant="ghost"
				size="xs"
				class="text-dim opacity-0 group-focus-within/message:opacity-100 group-hover/message:opacity-100 hover:text-amber focus-visible:opacity-100 max-md:opacity-100"
				aria-label="Copy link to this message"
				onclick={() => onCopyLink(href)}
			>
				<LinkIcon aria-hidden="true" />
				<span class="max-md:hidden">copy link</span>
			</Button>
		{/if}
		<a class="text-[13px] text-dim no-underline underline-offset-3 hover:text-foreground hover:underline" {href} title={`${utcStamp(message.time)} · link to this message`}>
			<time datetime={message.time}>{timeLabel}</time>
		</a>
	</span>
</div>
{#if message.deleted}
	<p class="m-0 font-sans text-[15px] text-dim italic">This message was deleted.</p>
{:else}
	<div class="message-body">{@html renderMessageMarkdown(message.text, colorByAuthor)}</div>
{/if}
{#if message.files.length > 0}
	<ul class="m-0 mt-1 flex list-none flex-wrap gap-2 p-0" aria-label="Files">
		{#each message.files as file (file.id)}
			<li>
				{#if isInlineImage(file.mime)}
					<a class="group/image relative block border border-border hover:border-amber" href={fileLink(file.id)} target="_blank" rel="noopener">
						<img
							class="peer relative z-[1] block max-h-60 max-w-[min(360px,100%)] object-contain transition-opacity duration-200 ease-out-quint not-data-loaded:min-h-25 not-data-loaded:min-w-40 group-hover/image:opacity-90"
							src={fileLink(file.id)}
							alt={file.name}
							loading="lazy"
							onload={(event) => ((event.currentTarget as HTMLImageElement).dataset.loaded = '')}
							onerror={(event) => ((event.currentTarget as HTMLImageElement).dataset.loaded = '')}
						/>
						<Skeleton class="absolute inset-0 rounded-none bg-secondary peer-data-loaded:hidden" />
					</a>
				{:else}
					<Button href={fileLink(file.id)} download={file.name} variant="outline" size="sm">
						<PaperclipIcon aria-hidden="true" /><span>{file.name}</span><span class="text-dim">{formatFileSize(file.size)}</span>
					</Button>
				{/if}
			</li>
		{/each}
	</ul>
{/if}
{#if message.reactions.length > 0}
	<ul class="m-0 mt-0.5 flex list-none flex-wrap gap-1.5 p-0" aria-label="Reactions">
		{#each message.reactions as reaction (reaction.emoji)}
			<li>
				<Popover.Root>
					<Popover.Trigger>
						{#snippet child({ props })}
							<Button {...props} variant="outline" size="xs" class="gap-1.5 font-normal text-subheading" aria-label={`:${reaction.emoji}: reactions, ${reaction.agents.length}`}>
								<span class="text-sm">{emojiForShortcode(reaction.emoji) ?? `:${reaction.emoji}:`}</span>
								<span class="tabular-nums">{reaction.agents.length}</span>
							</Button>
						{/snippet}
					</Popover.Trigger>
					<Popover.Content align="start" class="w-auto min-w-40 font-mono text-xs">
						<span class="text-dim">:{reaction.emoji}:</span>
						<ul class="m-0 mt-1 flex list-none flex-col gap-0.5 p-0">
							{#each reaction.agents as handle (handle)}
								<li style={authorColor(handle)}>{handle}</li>
							{/each}
						</ul>
					</Popover.Content>
				</Popover.Root>
			</li>
		{/each}
	</ul>
{/if}
