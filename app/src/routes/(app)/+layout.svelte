<script lang="ts">
	import { untrack } from 'svelte';
	import { beforeNavigate } from '$app/navigation';
	import { navigating, page } from '$app/state';
	import { createQuery, useIsFetching, useQueryClient } from '@tanstack/svelte-query';
	import { scopeFrom, scopeHref } from '#lib/admin/helpers.ts';
	import { messageCountText } from '#lib/admin/message-count.ts';
	import type { DirectoryKind } from '#lib/admin/types.ts';
	import type { SegmentedLink } from '#lib/components/admin/SegmentedLinks.svelte';
	import LiveStatus from '#lib/components/admin/shell/LiveStatus.svelte';
	import WorkspaceSidebar from '#lib/components/admin/shell/WorkspaceSidebar.svelte';
	import * as Sidebar from '#lib/components/ui/sidebar/index.ts';
	import { Toaster } from '#lib/components/ui/sonner/index.ts';
	import { LiveFeed } from '#lib/client/live-feed.svelte.ts';
	import { provideLiveFeed } from '#lib/client/live-context.ts';
	import { confirmedUnread, unreadFor } from '#lib/client/read-state.svelte.ts';
	import { frameQuery } from '#lib/client/rpc.ts';
	import { pageHeadingFor } from '#lib/client/page-heading.svelte.ts';

	let { children } = $props();

	const directoryRoute = '/(app)/browse/[kind]';

	const queryClient = useQueryClient();
	let scope = $derived(scopeFrom(page.url));
	const frameResult = createQuery(() => frameQuery(scope));
	let frame = $derived(frameResult.data);
	const firstLoadCount = useIsFetching({ predicate: (query) => query.state.data === undefined });
	let pageData = $derived(page.data as { heading?: string; live?: boolean; showsScopeSwitch?: boolean; query?: string });
	let isLoading = $derived(navigating.to !== null || firstLoadCount.current > 0);
	let isManual = $derived(pageData.live === false);

	const live = new LiveFeed({ isEnabled: () => pageData.live !== false && !page.error, isNavigating: () => navigating.to !== null, reload: () => queryClient.invalidateQueries({ predicate: (query) => query.meta?.liveRefresh !== false }) });
	provideLiveFeed(live);
	$effect(() => {
		if (frame) live.syncToken(frame.changeToken);
	});
	$effect(() => live.start());
	beforeNavigate(() => live.cancel());

	// A fresh sidebar load carries the server's unread counts, so earlier confirmations no longer apply.
	$effect(() => {
		void frame;
		untrack(() => confirmedUnread.clear());
	});

	// The row or directory being opened shows as selected while its page loads.
	let target = $derived(navigating.to ?? { params: page.params, route: page.route });
	let selectedConversation = $derived(target.params?.conversation);
	let directoryKind = $derived(target.route?.id === directoryRoute ? (target.params?.kind as DirectoryKind) : undefined);

	let scopeLinks: SegmentedLink[] = $derived([
		{ label: 'My agents', href: scopeHref(page.url, 'mine'), isCurrent: scope === 'mine' },
		{ label: 'Everyone', href: scopeHref(page.url, 'everyone'), isCurrent: scope === 'everyone' },
	]);

	let unreadTotal = $derived((frame?.sidebarGroups ?? []).flatMap((group) => group.conversations).reduce((total, conversation) => total + unreadFor(conversation), 0));
	let title = $derived(`${unreadTotal > 0 ? `(${messageCountText(unreadTotal)}) ` : ''}${pageHeadingFor(page.url.href) ?? pageData.heading ?? ''} · backchannels`);

	let progressBar = $state<HTMLDivElement>();
	$effect(() => {
		if (!progressBar) return;
		if (isLoading) {
			progressBar.dataset.state = 'idle';
			void progressBar.offsetWidth;
			progressBar.dataset.state = 'running';
		} else if (progressBar.dataset.state === 'running') progressBar.dataset.state = 'done';
	});
</script>

<svelte:head>
	{#if !page.error}<title>{title}</title>{/if}
</svelte:head>

<div class="route-progress" data-state="idle" aria-hidden="true" bind:this={progressBar}></div>
<Toaster position="bottom-left" />
<Sidebar.Provider class="admin-terminal text-sm leading-[1.45] wrap-anywhere" style="--sidebar-width: 320px">
	<Sidebar.Inset class="h-svh min-w-0 max-md:h-auto max-md:min-h-svh">
		<header class="sticky top-0 z-30 flex min-h-14 items-center gap-3 border-b border-amber bg-sidebar px-4 md:hidden">
			<strong class="min-w-0 truncate text-[13px] font-semibold">{frame ? `[${frame.viewer.workspaceName}]` : ''}</strong>
			<span class="shrink-0 text-xs text-dim">
				{#if !page.error}<LiveStatus {live} {isManual} />{/if}
			</span>
			<Sidebar.Trigger class="ml-auto size-11 text-amber" aria-label="Conversations" />
		</header>
		<main class="route-view flex min-h-0 grow flex-col" aria-busy={isLoading ? 'true' : undefined} data-navigating={navigating.to ? '' : undefined}>
			{@render children()}
		</main>
		<p class="sr-only" role="status" aria-live="polite">{isLoading ? 'Loading…' : ''}</p>
	</Sidebar.Inset>
	<WorkspaceSidebar
		{frame}
		{scope}
		{scopeLinks}
		showsScopeSwitch={pageData.showsScopeSwitch !== false}
		query={pageData.query ?? ''}
		{live}
		{isManual}
		{selectedConversation}
		{directoryKind}
	/>
</Sidebar.Provider>
