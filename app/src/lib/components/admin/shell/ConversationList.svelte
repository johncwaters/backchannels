<script lang="ts">
	import { untrack } from 'svelte';
	import { adminHref, conversationHref, formatRelative } from '#lib/admin/helpers.ts';
	import type { SidebarGroup } from '#lib/admin/frame.ts';
	import type { DirectoryKind, Scope } from '#lib/admin/types.ts';
	import { conversationPreviewText } from '#lib/admin/emoji.ts';
	import { messageCountText } from '#lib/admin/message-count.ts';
	import { unreadFor } from '#lib/client/read-state.svelte.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as Sidebar from '#lib/components/ui/sidebar/index.ts';
	import PrivacyMarker from '../directory/PrivacyMarker.svelte';
	import UnreadBadge from '../directory/UnreadBadge.svelte';
	import { conversationLabel, messagesTodayLabel, privacyMarkerFor } from '../directory/conversation-labels.ts';

	interface Props {
		groups: SidebarGroup[];
		nowMs: number;
		scope: Scope;
		selectedConversation?: string;
		directoryKind?: DirectoryKind;
		viewerEmail?: string;
	}

	let { groups, nowMs, scope, selectedConversation, directoryKind, viewerEmail }: Props = $props();

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

{#each groups as group (group.kind)}
	<Sidebar.Group>
		<div class="flex items-center justify-between gap-2">
			<Sidebar.GroupLabel class="tracking-[0.08em]">{group.title}</Sidebar.GroupLabel>
			<Button
				href={adminHref(`/browse/${group.kind}`, scope)}
				variant="ghost"
				size="xs"
				class="text-dim tabular-nums hover:text-amber aria-[current=page]:text-amber"
				aria-current={directoryKind === group.kind ? 'page' : undefined}
				aria-label={group.kind === 'public' ? `Browse all ${group.total} channels` : `Browse all ${group.total} private chats`}
			>All {group.total} →</Button>
		</div>
		<Sidebar.GroupContent>
			<Sidebar.Menu>
				{#each group.conversations as conversation (conversation.id)}
					{@const label = conversationLabel(conversation, viewerEmail)}
					{@const unread = unreadFor(conversation)}
					<Sidebar.MenuItem>
						<Sidebar.MenuButton isActive={conversation.id === selectedConversation} size="lg" class="h-auto flex-col items-stretch gap-0.5 py-1.5 data-active:shadow-[inset_2px_0_0_var(--color-amber)]">
							{#snippet child({ props })}
								<a {...props} href={conversationHref(conversation.id, scope)} aria-current={conversation.id === selectedConversation ? 'page' : undefined} title={label.fullName !== label.shownName ? label.fullName : undefined}>
									<span class="flex min-w-0 items-center gap-1.5">
										{#if unread > 0}<UnreadBadge count={unread} />{/if}
										<PrivacyMarker marker={privacyMarkerFor(conversation)} />
										<strong class={['min-w-0 truncate text-[13px] font-semibold', conversation.id === selectedConversation ? 'text-amber' : unread > 0 && 'text-white']}>{label.shownName}</strong>
										{#if label.hiddenMemberCount > 0}<span class="shrink-0 text-xs text-dim">+{label.hiddenMemberCount}</span>{/if}
										{#key pulses.get(conversation.id) ?? 0}
											<span class={['ml-auto shrink-0 text-xs whitespace-nowrap text-dim tabular-nums', pulses.has(conversation.id) && 'animate-[sidebar-pulse-accent_1400ms_var(--ease-out-quint)]']}>{formatRelative(conversation.lastActivity, nowMs)}</span>
										{/key}
									</span>
									<span class="flex min-w-0 items-baseline gap-2">
										<span class="min-w-0 grow truncate font-sans text-xs text-preview">{conversationPreviewText(conversation.preview)}</span>
										{#if conversation.messagesToday > 0}
											<span class="shrink-0 text-[11px] whitespace-nowrap text-dim tabular-nums" title={messagesTodayLabel(conversation.messagesToday)}>
												<span aria-hidden="true">{messageCountText(conversation.messagesToday)} today</span>
												<span class="sr-only">{messagesTodayLabel(conversation.messagesToday)}</span>
											</span>
										{/if}
									</span>
								</a>
							{/snippet}
						</Sidebar.MenuButton>
					</Sidebar.MenuItem>
				{/each}
			</Sidebar.Menu>
		</Sidebar.GroupContent>
	</Sidebar.Group>
{/each}
