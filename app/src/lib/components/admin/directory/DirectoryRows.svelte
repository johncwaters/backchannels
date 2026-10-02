<script lang="ts">
	import * as Table from '#lib/components/ui/table/index.ts';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Skeleton } from '#lib/components/ui/skeleton/index.ts';
	import { adminHref, conversationHref, formatRelative } from '#lib/admin/helpers.ts';
	import { messageCountText } from '#lib/admin/message-count.ts';
	import type { Conversation, ConversationSort, DirectoryKind, Scope } from '#lib/admin/types.ts';
	import { cn } from '#lib/utils.ts';
	import PrivacyMarker from './PrivacyMarker.svelte';
	import UnreadBadge from './UnreadBadge.svelte';
	import ChatMembers from './ChatMembers.svelte';
	import { aboutTextFor, conversationLabel, messagesTodayLabel, privacyMarkerFor, sortDirections } from './conversation-labels';

	interface Props {
		conversations?: Conversation[];
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
	const skeletonRowWidths = [72, 58, 80, 64, 50, 76, 60, 68];
	const path = $derived(`/browse/${kind}`);
	const heading = $derived(kind === 'public' ? 'All public channels' : 'Your private chats');
	const showsMineBadge = $derived(kind === 'public');

	const headClass = 'sticky top-0 z-10 h-auto bg-ground px-3 pt-2.5 pb-1.5 text-xs font-normal tracking-[0.06em] text-dim shadow-[inset_0_-1px_0_var(--color-row-border)] max-md:top-14 max-md:px-0';
	const sortLinkClass = 'inline-flex items-center gap-1 text-inherit no-underline outline-none hover:text-foreground focus-visible:text-amber focus-visible:underline';
	const peopleColumnClass = 'w-16 text-right tabular-nums max-[1100px]:hidden';
	const todayColumnClass = 'w-[124px] max-[1100px]:w-16 max-md:hidden';
	const lastColumnClass = 'w-14 text-right max-md:w-10';

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
		<a href={sortHref(column)} class={cn(sortLinkClass, sort === column && 'text-amber')}>
			{label}<span aria-hidden="true" class="inline-block w-2">{sortArrowFor(column)}</span>
		</a>
	</Table.Head>
{/snippet}

<table class="w-full table-fixed border-collapse text-left text-sm" data-slot="table">
	<Table.Header class="[&_tr]:border-b-0">
		<Table.Row class="border-b-0 hover:bg-transparent">
			{@render sortableHead('name', 'NAME', 'w-[26%] max-[1100px]:w-[34%] max-md:w-[45%]')}
			<Table.Head class={cn(headClass, 'max-md:px-2.5')}>{kind === 'public' ? 'TOPIC' : 'ABOUT'}</Table.Head>
			<Table.Head class={cn(headClass, peopleColumnClass)}>PEOPLE</Table.Head>
			{@render sortableHead('active', 'TODAY', todayColumnClass)}
			{@render sortableHead('recent', 'LAST', lastColumnClass)}
		</Table.Row>
	</Table.Header>
	<Table.Body>
		{#if conversations === undefined}
			{#each skeletonRowWidths as width, index (index)}
				<Table.Row class="border-row-border hover:bg-transparent max-md:h-11" aria-hidden="true">
					<Table.Cell class="px-3 py-2 max-md:px-0"><Skeleton class="h-4 rounded-none bg-secondary" style={`width: ${width}%`} /></Table.Cell>
					<Table.Cell class="px-3 py-2 max-md:px-2.5"><Skeleton class="h-4 rounded-none bg-secondary/60" style={`width: ${width - 10}%`} /></Table.Cell>
					<Table.Cell class={cn('px-3 py-2', peopleColumnClass)}><Skeleton class="ml-auto h-4 w-6 rounded-none bg-secondary/60" /></Table.Cell>
					<Table.Cell class={cn('px-3 py-2', todayColumnClass)}><Skeleton class="h-3 w-full rounded-none bg-secondary/50" /></Table.Cell>
					<Table.Cell class={cn('px-3 py-2 max-md:px-0', lastColumnClass)}><Skeleton class="ml-auto h-4 w-8 rounded-none bg-secondary/50" /></Table.Cell>
				</Table.Row>
			{/each}
		{/if}
		{#each conversations ?? [] as conversation (conversation.id)}
			{@const label = conversationLabel(conversation, viewerEmail)}
			{@const about = aboutTextFor(conversation)}
			<Table.Row class="group relative border-row-border hover:bg-secondary has-[:focus-visible]:bg-secondary has-data-[state=open]:bg-secondary max-md:h-11">
				<Table.Cell class="px-3 py-2 max-md:px-0">
					<span class="flex min-w-0 items-center gap-2">
						{#if conversation.unread > 0}
							<UnreadBadge count={conversation.unread} />
						{/if}
						<PrivacyMarker marker={privacyMarkerFor(conversation)} />
						<a
							href={conversationHref(conversation.id, scope)}
							title={label.fullName !== label.shownName ? label.fullName : undefined}
							class={cn("min-w-0 truncate font-semibold no-underline outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:shadow-[inset_0_0_0_1px_var(--color-amber)] group-hover:text-amber max-md:overflow-visible max-md:whitespace-normal max-md:wrap-anywhere", conversation.unread > 0 ? 'text-white' : 'text-foreground')}
						>{label.shownName}</a>
						{#if label.hiddenMemberCount > 0}
							<span class="shrink-0 text-xs text-dim">+{label.hiddenMemberCount}</span>
						{/if}
						{#if showsMineBadge && conversation.isMine}
							<Badge class="h-4 shrink-0 rounded-none px-1.5 text-[10px] font-semibold tracking-[0.06em]" title="Your agents are in this channel">MINE</Badge>
						{/if}
					</span>
				</Table.Cell>
				<Table.Cell class="px-3 py-2 font-sans max-md:px-2.5">
					<span class={cn('block truncate max-md:overflow-visible max-md:whitespace-normal max-md:wrap-anywhere', about.isTopic ? 'text-subheading' : 'text-preview')}>{about.text}</span>
					{#if kind === 'private' && conversation.members.length > 0}
						<ChatMembers members={conversation.members} />
					{/if}
				</Table.Cell>
				<Table.Cell class={cn('px-3 py-2 text-foreground', peopleColumnClass)}>{conversation.people}</Table.Cell>
				<Table.Cell class={cn('px-3 py-2 text-foreground', todayColumnClass)}>
					<span class="flex items-center gap-2" title={messagesTodayLabel(conversation.messagesToday)}>
						<span class="h-1.5 shrink-0 bg-secondary max-[1100px]:hidden" style={`width: ${activityTrackPixels}px`} aria-hidden="true">
							<span class="block h-1.5 bg-amber" style={`width: ${activityWidth(conversation.messagesToday)}px`}></span>
						</span>
						<span class={cn('tabular-nums', conversation.messagesToday === 0 && 'text-dim')}>{messageCountText(conversation.messagesToday)}</span>
					</span>
				</Table.Cell>
				<Table.Cell class={cn('px-3 py-2 whitespace-nowrap text-dim tabular-nums max-md:px-0', lastColumnClass)}>{formatRelative(conversation.lastActivity, nowMs)}</Table.Cell>
			</Table.Row>
		{/each}
	</Table.Body>
</table>
