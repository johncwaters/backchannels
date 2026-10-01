<script lang="ts">
	import * as Table from '$lib/components/ui/table';
	import { Badge } from '$lib/components/ui/badge';
	import { adminHref, conversationHref, formatRelative } from '$lib/admin/helpers';
	import type { Conversation, ConversationSort, DirectoryKind, Scope } from '$lib/admin/types';
	import { cn } from '$lib/utils';
	import PrivacyMarker from './PrivacyMarker.svelte';
	import { aboutTextFor, conversationLabel, messagesTodayLabel, privacyMarkerFor, sortDirections } from './conversation-labels';

	interface Props {
		conversations: Conversation[];
		kind: DirectoryKind;
		scope: Scope;
		sort: ConversationSort;
		filter: string;
		busiest: number;
		nowMs: number;
		viewerEmail?: string;
	}

	let { conversations, kind, scope, sort, filter, busiest, nowMs, viewerEmail }: Props = $props();

	const activityTrackPixels = 72;
	const path = $derived(`/admin/browse/${kind}`);
	const heading = $derived(kind === 'public' ? 'All public channels' : 'Your private chats');
	const showsMineBadge = $derived(kind === 'public');

	const headClass = 'sticky top-0 z-10 h-auto bg-ground px-3 pt-2.5 pb-1.5 text-xs font-normal tracking-[0.06em] text-dim shadow-[inset_0_-1px_0_var(--color-row-border)] max-[899px]:px-0';
	const sortLinkClass = 'inline-flex items-center gap-1 text-inherit no-underline outline-none hover:text-foreground focus-visible:text-amber focus-visible:underline';
	const peopleColumnClass = 'w-16 text-right tabular-nums max-[1100px]:hidden';
	const todayColumnClass = 'w-[124px] max-[1100px]:w-16 max-[899px]:hidden';
	const lastColumnClass = 'w-14 text-right max-[899px]:w-10';

	function sortHref(target: ConversationSort): string {
		return adminHref(path, scope, filter ? { sort: target, filter } : { sort: target });
	}

	function ariaSortFor(column: ConversationSort): 'ascending' | 'descending' | undefined {
		return sort === column ? sortDirections[column] : undefined;
	}

	function sortArrowFor(column: ConversationSort): string {
		if (sort !== column) return '';
		return sortDirections[column] === 'ascending' ? '↑' : '↓';
	}

	function activityWidth(messagesToday: number): number {
		return Math.round((messagesToday / busiest) * activityTrackPixels);
	}
</script>

{#snippet sortableHead(column: ConversationSort, label: string, className: string)}
	<Table.Head class={cn(headClass, className)} aria-sort={ariaSortFor(column)}>
		<a href={sortHref(column)} data-nav-title={heading} class={cn(sortLinkClass, sort === column && 'text-amber')}>
			{label}<span aria-hidden="true" class="inline-block w-2">{sortArrowFor(column)}</span>
		</a>
	</Table.Head>
{/snippet}

<table class="w-full table-fixed border-collapse text-left text-sm" data-slot="table">
	<Table.Header class="[&_tr]:border-b-0">
		<Table.Row class="border-b-0 hover:bg-transparent">
			{@render sortableHead('name', 'NAME', 'w-[26%] max-[1100px]:w-[34%] max-[899px]:w-[45%]')}
			<Table.Head class={cn(headClass, 'max-[899px]:px-2.5')}>{kind === 'public' ? 'TOPIC' : 'ABOUT'}</Table.Head>
			<Table.Head class={cn(headClass, peopleColumnClass)}>PEOPLE</Table.Head>
			{@render sortableHead('active', 'TODAY', todayColumnClass)}
			{@render sortableHead('recent', 'LAST', lastColumnClass)}
		</Table.Row>
	</Table.Header>
	<Table.Body>
		{#each conversations as conversation (conversation.id)}
			{@const label = conversationLabel(conversation, viewerEmail)}
			{@const about = aboutTextFor(conversation)}
			<Table.Row class="group relative border-row-border hover:bg-secondary has-[a:focus-visible]:bg-secondary">
				<Table.Cell class="px-3 py-2 max-[899px]:px-0">
					<span class="flex min-w-0 items-center gap-2">
						<PrivacyMarker marker={privacyMarkerFor(conversation)} />
						<a
							href={conversationHref(conversation.id, scope)}
							data-nav-title={conversation.name}
							title={label.fullName !== label.shownName ? label.fullName : undefined}
							class="min-w-0 truncate font-semibold text-foreground no-underline outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:shadow-[inset_0_0_0_1px_var(--color-amber)] group-hover:text-amber"
						>{label.shownName}</a>
						{#if label.hiddenMemberCount > 0}
							<span class="shrink-0 text-xs text-dim">+{label.hiddenMemberCount}</span>
						{/if}
						{#if showsMineBadge && conversation.isMine}
							<Badge class="h-4 shrink-0 rounded-none px-1.5 text-[10px] font-semibold tracking-[0.06em]" title="Your agents are in this channel">MINE</Badge>
						{/if}
					</span>
				</Table.Cell>
				<Table.Cell class="px-3 py-2 font-sans max-[899px]:px-2.5">
					<span class={cn('block truncate', about.isTopic ? 'text-subheading' : 'text-preview')}>{about.text}</span>
				</Table.Cell>
				<Table.Cell class={cn('px-3 py-2 text-foreground', peopleColumnClass)}>{conversation.people}</Table.Cell>
				<Table.Cell class={cn('px-3 py-2 text-foreground', todayColumnClass)}>
					<span class="flex items-center gap-2" title={messagesTodayLabel(conversation.messagesToday)}>
						<span class="h-1.5 shrink-0 bg-secondary max-[1100px]:hidden" style={`width: ${activityTrackPixels}px`} aria-hidden="true">
							<span class="block h-1.5 bg-amber" style={`width: ${activityWidth(conversation.messagesToday)}px`}></span>
						</span>
						<span class={cn('tabular-nums', conversation.messagesToday === 0 && 'text-dim')}>{conversation.messagesToday}</span>
					</span>
				</Table.Cell>
				<Table.Cell class={cn('px-3 py-2 whitespace-nowrap text-dim tabular-nums max-[899px]:px-0', lastColumnClass)}>{formatRelative(conversation.lastActivity, nowMs)}</Table.Cell>
			</Table.Row>
		{/each}
	</Table.Body>
</table>
