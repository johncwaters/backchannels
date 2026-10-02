<script lang="ts">
	import { untrack } from 'svelte';
	import { adminHref, conversationHref, formatRelative } from '#lib/admin/helpers.ts';
	import type { SidebarGroup } from '#lib/admin/frame.ts';
	import type { DirectoryKind, Scope } from '#lib/admin/types.ts';
	import { conversationPreviewText } from '#lib/admin/emoji.ts';
	import { messageCountText } from '#lib/admin/message-count.ts';
	import { unreadFor } from '#lib/client/read-state.svelte.ts';
	import PrivacyMarker from '../directory/PrivacyMarker.svelte';
	import UnreadBadge from '../directory/UnreadBadge.svelte';
	import { conversationLabel, messagesTodayLabel, privacyMarkerFor } from '../directory/conversation-labels';

	interface Props {
		groups: SidebarGroup[];
		nowMs: number;
		scope: Scope;
		selectedConversation?: string;
		directoryKind?: DirectoryKind;
		viewerEmail?: string;
	}

	let { groups, nowMs, scope, selectedConversation, directoryKind, viewerEmail }: Props = $props();

	const rowClass = 'conversation group flex min-w-0 flex-col px-2.5 py-[5px] text-foreground no-underline shadow-[inset_0_0_0_var(--color-amber)] outline-none hover:bg-secondary focus-visible:bg-secondary focus-visible:shadow-[inset_0_0_0_1px_var(--color-amber)] aria-[current=page]:bg-secondary aria-[current=page]:shadow-[inset_2px_0_0_var(--color-amber)]';
	const browseClass = 'whitespace-nowrap text-dim no-underline tabular-nums transition-colors duration-150 hover:text-amber focus-visible:text-amber aria-[current=page]:text-amber';

	// A row whose preview changed since the last sidebar load pulses its time once.
	let previousPreviews = new Map<string, string>();
	let pulses = $state(new Map<string, number>());
	$effect.pre(() => {
		const currentPreviews = new Map(groups.flatMap((group) => group.conversations.map((conversation) => [conversation.id, conversation.preview] as const)));
		const nextPulses = new Map(untrack(() => pulses));
		for (const [id, preview] of currentPreviews) {
			const previous = previousPreviews.get(id);
			if (previous !== undefined && previous !== preview) nextPulses.set(id, (nextPulses.get(id) ?? 0) + 1);
		}
		previousPreviews = currentPreviews;
		pulses = nextPulses;
	});
</script>

<nav aria-label="Conversations" class="relative flex grow flex-col gap-3.5 overflow-auto px-1.5 pt-2.5 pb-3.5" data-conversation-list>
	{#each groups as group (group.kind)}
		<section class="flex min-w-0 flex-col gap-0.5">
			<div class="flex items-baseline justify-between gap-2 px-2 pb-1.5 text-xs text-dim">
				<h2 class="m-0 text-[length:inherit] font-normal tracking-[0.08em]">{group.title}</h2>
				<a
					class={browseClass}
					href={adminHref(`/browse/${group.kind}`, scope)}
					aria-current={directoryKind === group.kind ? 'page' : undefined}
					aria-label={group.kind === 'public' ? `Browse all ${group.total} channels` : `Browse all ${group.total} private chats`}
					data-nav-title={group.kind === 'public' ? 'All public channels' : 'Your private chats'}
				>All {group.total} →</a>
			</div>
			{#each group.conversations as conversation (conversation.id)}
				{@const label = conversationLabel(conversation, viewerEmail)}
				{@const unread = unreadFor(conversation)}
				<a
					class={rowClass}
					href={conversationHref(conversation.id, scope)}
					aria-current={conversation.id === selectedConversation ? 'page' : undefined}
					data-unread={unread > 0 ? unread : undefined}
					data-nav-title={conversation.name}
					title={label.fullName !== label.shownName ? label.fullName : undefined}
				>
					<span class="flex min-w-0 items-center gap-1.5">
						{#if unread > 0}<UnreadBadge count={unread} />{/if}
						<PrivacyMarker marker={privacyMarkerFor(conversation)} />
						<strong class="min-w-0 truncate text-[13px] font-semibold group-data-[unread]:text-white group-aria-[current=page]:text-amber">{label.shownName}</strong>
						{#if label.hiddenMemberCount > 0}<span class="shrink-0 text-xs text-dim">+{label.hiddenMemberCount}</span>{/if}
						{#key pulses.get(conversation.id) ?? 0}
							<span class={['last-active ml-auto shrink-0 text-xs whitespace-nowrap text-dim tabular-nums', pulses.has(conversation.id) && 'animate-[sidebar-pulse-accent_1400ms_var(--ease-out-quint)]']}>{formatRelative(conversation.lastActivity, nowMs)}</span>
						{/key}
					</span>
					<span class="flex min-w-0 items-baseline gap-2">
						<span class="preview min-w-0 grow truncate font-sans text-xs text-preview">{conversationPreviewText(conversation.preview)}</span>
						{#if conversation.messagesToday > 0}
							<span class="shrink-0 text-[11px] whitespace-nowrap text-dim tabular-nums" title={messagesTodayLabel(conversation.messagesToday)}>
								<span aria-hidden="true">{messageCountText(conversation.messagesToday)} today</span>
								<span class="sr-only">{messagesTodayLabel(conversation.messagesToday)}</span>
							</span>
						{/if}
					</span>
				</a>
			{/each}
		</section>
	{/each}
</nav>
