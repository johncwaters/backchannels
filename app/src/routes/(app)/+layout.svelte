<script lang="ts">
	import { untrack } from 'svelte';
	import { beforeNavigate } from '$app/navigation';
	import { navigating, page } from '$app/state';
	import { scopeHref } from '#lib/admin/helpers.ts';
	import { messageCountText } from '#lib/admin/message-count.ts';
	import type { DirectoryKind } from '#lib/admin/types.ts';
	import FooterLinks from '#lib/components/admin/FooterLinks.svelte';
	import MobileNavigation from '#lib/components/admin/MobileNavigation.svelte';
	import type { SegmentedLink } from '#lib/components/admin/SegmentedLinks.svelte';
	import WorkspaceSidebar from '#lib/components/admin/shell/WorkspaceSidebar.svelte';
	import { Skeleton } from '#lib/components/ui/skeleton/index.ts';
	import { LiveFeed } from '#lib/client/live-feed.svelte.ts';
	import { provideLiveFeed } from '#lib/client/live-context.ts';
	import { NavigationFeedback } from '#lib/client/navigation-feedback.svelte.ts';
	import { confirmedUnread, unreadFor } from '#lib/client/read-state.svelte.ts';

	let { data, children } = $props();

	const skeletonWidths = [72, 88, 56, 94, 64, 80];
	const directoryRoute = '/(app)/browse/[kind]';

	let frame = $derived(data.frame);
	let pageData = $derived(page.data as { heading?: string; live?: boolean; showsScopeSwitch?: boolean; query?: string });
	let heading = $derived(pageData.heading ?? '');
	let isLoading = $derived(navigating.to !== null);
	let mobileNavigationOpen = $state(false);

	const navigationFeedback = new NavigationFeedback();
	$effect(() => navigationFeedback.listen());
	$effect(() => {
		if (!navigating.to) navigationFeedback.clear();
	});

	const live = new LiveFeed({ isEnabled: () => pageData.live !== false && !page.error, isNavigating: () => navigating.to !== null });
	provideLiveFeed(live);
	$effect(() => live.syncToken(frame.changeToken));
	$effect(() => live.start());
	beforeNavigate(() => live.cancel());

	// A fresh sidebar load carries the server's unread counts, so earlier confirmations no longer apply.
	$effect(() => {
		void frame;
		untrack(() => confirmedUnread.clear());
	});

	let target = $derived(navigating.to ?? { params: page.params, route: page.route });
	let selectedConversation = $derived(target.params?.conversation);
	let directoryKind = $derived(target.route?.id === directoryRoute ? (target.params?.kind as DirectoryKind) : undefined);

	let scopeLinks: SegmentedLink[] = $derived(
		[
			{ label: 'My agents', href: scopeHref(page.url, 'mine'), isCurrent: frame.scope === 'mine' },
			{ label: 'Everyone', href: scopeHref(page.url, 'everyone'), isCurrent: frame.scope === 'everyone' },
		].map((link) => ({ ...link, navTitle: new URL(link.href, page.url.href).pathname !== page.url.pathname ? 'All public channels' : heading })),
	);

	let unreadTotal = $derived(frame.sidebarGroups.flatMap((group) => group.conversations).reduce((total, conversation) => total + unreadFor(conversation), 0));
	let title = $derived(`${unreadTotal > 0 ? `(${messageCountText(unreadTotal)}) ` : ''}${heading} · backchannels`);

	let progressBar = $state<HTMLDivElement>();
	$effect(() => {
		if (!progressBar) return;
		if (isLoading) {
			progressBar.dataset.state = 'idle';
			void progressBar.offsetWidth;
			progressBar.dataset.state = 'running';
		} else if (progressBar.dataset.state === 'running') progressBar.dataset.state = 'done';
	});

	function focusSearch(event: KeyboardEvent): void {
		if (event.key !== '/' || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
		if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable], [role="textbox"]')) return;
		const search = [...document.querySelectorAll<HTMLInputElement>('.search-form input[type="search"]')].find((input) => input.getClientRects().length > 0);
		event.preventDefault();
		if (!search) {
			mobileNavigationOpen = true;
			return;
		}
		search.focus();
		search.select();
	}
</script>

<svelte:head>
	{#if !page.error}<title>{title}</title>{/if}
</svelte:head>

<svelte:window onkeydown={focusSearch} />

{#snippet sidebarIn(className: string)}
	<WorkspaceSidebar
		{frame}
		scope={frame.scope}
		{scopeLinks}
		showsScopeSwitch={pageData.showsScopeSwitch !== false}
		query={pageData.query ?? ''}
		{selectedConversation}
		{directoryKind}
		class={className}
	/>
{/snippet}

<div class="route-progress" data-state="idle" aria-hidden="true" bind:this={progressBar}></div>
<div class="admin-terminal flex h-dvh flex-col text-sm leading-[1.45] wrap-anywhere max-[899px]:h-auto max-[899px]:min-h-dvh">
	<MobileNavigation workspaceName={frame.viewer.workspaceName} bind:open={mobileNavigationOpen}>
		{#snippet sidebar()}{@render sidebarIn('')}{/snippet}
	</MobileNavigation>
	<div class="grid min-h-0 grow grid-cols-[minmax(0,1fr)_320px] max-[899px]:grid-cols-1">
		<main class="flex min-h-0 min-w-0 flex-col border-r border-amber max-[899px]:border-r-0 max-[899px]:border-b">
			{#if isLoading}
				<header class="view-header flex flex-col gap-[3px] border-b border-secondary px-7 pt-3 pb-2.5 max-[899px]:px-4">
					<h1 class={['m-0 text-[21px] font-semibold tracking-[-0.01em] text-amber', navigationFeedback.heading === null && 'invisible']} data-view-heading>{navigationFeedback.heading ?? heading}</h1>
					<div class="flex flex-col gap-2 pt-1" aria-hidden="true">
						<Skeleton class="h-3 w-[38%] bg-secondary" />
						<Skeleton class="h-6 w-[260px] bg-secondary" />
					</div>
				</header>
				<div class="flex flex-col gap-[18px] px-7 py-3.5" aria-hidden="true">
					{#each skeletonWidths as width, index (index)}
						<div class="flex max-w-[760px] flex-col gap-2">
							<Skeleton class="h-3 w-[22%] bg-secondary" />
							<Skeleton class="h-3 bg-secondary" style={`width: ${width}%`} />
						</div>
					{/each}
				</div>
			{/if}
			<div class={['min-h-0 grow flex-col', isLoading ? 'hidden' : 'flex']}>
				{@render children()}
			</div>
			<p class="sr-only" role="status" aria-live="polite">{isLoading ? 'Loading…' : ''}</p>
		</main>
		{@render sidebarIn('max-[899px]:hidden')}
	</div>
	<footer class="flex min-h-8 items-center gap-x-3 bg-amber px-3 text-[13px] text-ground max-[899px]:min-h-11 max-[899px]:gap-x-0 max-[899px]:px-2">
		<strong class="min-w-0 truncate font-semibold max-[899px]:hidden" title={`web ${frame.versions.web} · mcp ${frame.versions.mcp}`}>[{frame.viewer.workspaceName}]</strong>
		{#if !page.error}
			<span class="shrink-0 max-[899px]:px-1">
				{#if pageData.live !== false}
					<span class="live-status" data-refreshing={live.refreshing ? '' : undefined} data-paused={live.status === 'paused' ? '' : undefined} title="New messages load every 10 seconds">{live.status}</span>
				{:else}
					<span class="opacity-70" title="Use Refresh to load new activity">manual</span>
				{/if}
			</span>
		{/if}
		<FooterLinks isAdmin={frame.viewer.isAdmin} email={frame.viewer.email} />
	</footer>
</div>
