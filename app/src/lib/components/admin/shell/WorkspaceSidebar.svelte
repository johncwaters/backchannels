<script lang="ts">
	import { tick } from 'svelte';
	import { beforeNavigate } from '$app/navigation';
	import SearchIcon from '@lucide/svelte/icons/search';
	import type { AdminFrame } from '#lib/admin/frame.ts';
	import type { DirectoryKind, Scope } from '#lib/admin/types.ts';
	import type { LiveFeed } from '#lib/client/live-feed.svelte.ts';
	import * as InputGroup from '#lib/components/ui/input-group/index.ts';
	import { Kbd } from '#lib/components/ui/kbd/index.ts';
	import * as Sidebar from '#lib/components/ui/sidebar/index.ts';
	import { Skeleton } from '#lib/components/ui/skeleton/index.ts';
	import FooterLinks from '../FooterLinks.svelte';
	import Hint from '../Hint.svelte';
	import SegmentedLinks, { type SegmentedLink } from '../SegmentedLinks.svelte';
	import ConversationList from './ConversationList.svelte';
	import LiveStatus from './LiveStatus.svelte';

	interface Props {
		frame: AdminFrame | undefined;
		scope: Scope;
		scopeLinks: SegmentedLink[];
		showsScopeSwitch: boolean;
		query: string;
		live: LiveFeed;
		isManual: boolean;
		selectedConversation?: string;
		directoryKind?: DirectoryKind;
	}

	let { frame, scope, scopeLinks, showsScopeSwitch, query, live, isManual, selectedConversation, directoryKind }: Props = $props();

	const skeletonRows = [62, 48, 70, 55, 40, 66];
	const sidebar = Sidebar.useSidebar();
	let search = $state<HTMLInputElement | null>(null);

	beforeNavigate(() => sidebar.setOpenMobile(false));

	// `/` focuses workspace search outside text fields; on a narrow screen it opens the sidebar first.
	async function focusSearch(event: KeyboardEvent): Promise<void> {
		if (event.key !== '/' || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
		if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable], [role="textbox"]')) return;
		event.preventDefault();
		if (sidebar.isMobile && !sidebar.openMobile) {
			sidebar.setOpenMobile(true);
			await tick();
		}
		search?.focus();
		search?.select();
	}
</script>

<svelte:window onkeydown={focusSearch} />

<Sidebar.Root side="right" class="md:border-s md:border-amber" aria-label="Workspace conversations">
	<Sidebar.Header class="gap-2 border-b border-secondary">
		<form action="/search" method="get" role="search">
			<input type="hidden" name="scope" value={scope} />
			<InputGroup.Root class="bg-ground">
				<InputGroup.Addon><SearchIcon aria-hidden="true" /></InputGroup.Addon>
				<InputGroup.Input bind:ref={search} type="search" name="q" value={query} aria-label="Search conversations" aria-keyshortcuts="/" placeholder="Search conversations" />
				<InputGroup.Addon align="inline-end" class="max-md:hidden"><Kbd>/</Kbd></InputGroup.Addon>
			</InputGroup.Root>
		</form>
		{#if showsScopeSwitch}<SegmentedLinks links={scopeLinks} label="Whose agents to show" class="w-full" />{/if}
	</Sidebar.Header>
	<Sidebar.Content data-conversation-list>
		{#if frame}
			<ConversationList groups={frame.sidebarGroups} nowMs={frame.nowMs} {scope} viewerEmail={frame.viewer.email} {selectedConversation} {directoryKind} />
		{:else}
			<div class="flex flex-col gap-4 px-3 py-3" aria-hidden="true">
				{#each skeletonRows as width, index (index)}
					<div class="flex flex-col gap-1.5">
						<Skeleton class="h-3.5 rounded-none bg-secondary" style={`width: ${width}%`} />
						<Skeleton class="h-3 w-[85%] rounded-none bg-secondary/60" />
					</div>
				{/each}
			</div>
		{/if}
	</Sidebar.Content>
	<Sidebar.Footer class="flex-row items-center gap-x-3 bg-amber px-3 py-0 text-[13px] text-ground">
		{#if frame}
			<Hint text={`web ${frame.versions.web} · mcp ${frame.versions.mcp}`} class="min-w-0 cursor-default max-md:hidden"><strong class="truncate font-semibold">[{frame.viewer.workspaceName}]</strong></Hint>
			<span class="shrink-0"><LiveStatus {live} {isManual} /></span>
			<FooterLinks isAdmin={frame.viewer.isAdmin} email={frame.viewer.email} />
		{:else}
			<Skeleton class="h-3.5 w-24 rounded-none bg-ground/20" />
		{/if}
	</Sidebar.Footer>
</Sidebar.Root>
