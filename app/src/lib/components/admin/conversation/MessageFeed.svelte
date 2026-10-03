<script lang="ts">
	import { onMount, tick } from 'svelte';
	import type { Attachment } from 'svelte/attachments';
	import { SvelteSet } from 'svelte/reactivity';
	import { afterNavigate } from '$app/navigation';
	import { navigating } from '$app/state';
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import { toast } from 'svelte-sonner';
	import { dayLabel, distinctAgentColors, formatClockTime, groupMessagesByDay, messageAnchor, replyCountLabel } from '#lib/admin/helpers.ts';
	import { mergeMessages, messagesHref, newestWindowBefore, prependOlder } from '#lib/admin/conversation-page.ts';
	import type { ConversationPage, Message } from '#lib/admin/types.ts';
	import { isAwayFromLatest, isNearBottom, isNearTop, newMessagesText, readingAnchor, restoreReadingAnchor, scrollBehavior, scrollContainer } from '#lib/client/feed-scroll.ts';
	import { liveFeed } from '#lib/client/live-context.ts';
	import { confirmedUnread } from '#lib/client/read-state.svelte.ts';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Separator } from '#lib/components/ui/separator/index.ts';
	import { Spinner } from '#lib/components/ui/spinner/index.ts';
	import InlineThread from './InlineThread.svelte';
	import MessageContent from './MessageContent.svelte';
	import { continuesPreviousMessage } from './message-grouping';

	interface Props {
		conversationId: string;
		conversationName: string;
		messages: Message[];
		nowMs: number;
		messageLink: (message: Message) => string;
		fileLink: (fileId: string) => string;
		nextBefore?: number;
		newerMessagesHref?: string;
		latestMessagesHref?: string;
		threadHref?: (rootSeq: number) => string;
		threadRootSeq?: number;
		targetSeq?: number;
		showsPins?: boolean;
		readState?: { lastReadSeq: number; firstUnreadSeq?: number };
	}

	let {
		conversationId,
		conversationName,
		messages: loadedMessages,
		nowMs,
		messageLink,
		fileLink,
		nextBefore,
		newerMessagesHref,
		latestMessagesHref,
		threadHref,
		threadRootSeq,
		targetSeq,
		showsPins = false,
		readState,
	}: Props = $props();

	const pageTimeoutMs = 8_000;
	const markReadDelayMs = 700;
	const visibleShareToCountAsRead = 0.6;
	const edgeBleed = '-mx-7 px-7 max-md:-mx-4 max-md:px-4';

	// History the reader loaded by scrolling up, joined with live refreshes of the newest window.
	let messages = $derived(loadedMessages);
	let olderBefore = $derived(nextBefore);
	let olderState = $state<'ready' | 'loading' | 'failed'>('ready');
	let failedBefore: number | undefined;
	let keepsExhaustedControl = $state(false);
	const arrived = new SvelteSet<number>();
	let unreadArrivals = $state(0);
	let awayFromLatest = $state(false);
	let canCopyLinks = $state(false);
	let feed = $state<HTMLElement>();
	let olderControl = $state<HTMLElement>();
	let isMounted = true;

	let showsDays = $derived(!showsPins);
	let opensAtEnd = $derived(targetSeq === undefined && !newerMessagesHref && showsDays);
	let firstUnreadSeq = $derived(readState?.firstUnreadSeq);
	let unreadDividerShown = $derived(firstUnreadSeq !== undefined && messages.some((message) => message.seq === firstUnreadSeq));
	let threadRoot = $derived(messages.find((message) => message.seq === threadRootSeq));
	let heading = $derived(threadRootSeq ? `Thread in ${conversationName}` : conversationName);
	let days = $derived(showsDays ? groupMessagesByDay(messages, nowMs) : [{ label: '', messages }]);
	let colorByAuthor = $derived(distinctAgentColors(messages.map((message) => message.handle)));

	const messageHeading = (message: Message) => (message.threadRootSeq && !message.alsoInChannel ? `Thread in ${conversationName}` : conversationName);
	const visibleTime = (message: Message) => (showsDays ? formatClockTime(message.time) : `${dayLabel(message.time, nowMs)} ${formatClockTime(message.time)}`);
	const isContinuation = (dayMessages: Message[], index: number) => showsDays && continuesPreviousMessage(dayMessages[index], dayMessages[index - 1], { threadRootSeq, targetSeq });

	async function fetchPage(before: number, signal?: AbortSignal): Promise<ConversationPage> {
		const timeout = AbortSignal.timeout(pageTimeoutMs);
		const response = await fetch(messagesHref(conversationId, before, threadRootSeq), { headers: { accept: 'application/json' }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
		if (!response.ok) throw new Error(`Message page unavailable (${response.status})`);
		return (await response.json()) as ConversationPage;
	}

	// Opens at the linked message, then the first unread message, then the newest message.
	function openAtReadingPosition(): void {
		const target = location.hash ? document.getElementById(location.hash.slice(1)) : feed?.querySelector<HTMLElement>('article.target');
		if (target) {
			target.scrollIntoView({ block: 'start' });
			return;
		}
		if (location.hash) return;
		const firstUnread = feed?.querySelector<HTMLElement>('[data-first-unread]');
		if (firstUnread) firstUnread.scrollIntoView({ block: 'start' });
		else if (opensAtEnd) feed?.lastElementChild?.scrollIntoView({ block: 'end' });
	}

	async function loadOlderMessages(): Promise<void> {
		const before = olderBefore;
		if (!feed || before === undefined || olderState === 'loading' || navigating.to) return;
		olderState = 'loading';
		try {
			const page = await fetchPage(before);
			if (!isMounted) return;
			const anchor = readingAnchor(feed);
			arrived.clear();
			const shownBefore = messages.length;
			messages = prependOlder(messages, page.messages);
			const added = messages.length - shownBefore;
			keepsExhaustedControl = added === 0 || !page.nextBefore ? Boolean(olderControl?.contains(document.activeElement)) : false;
			olderBefore = added > 0 ? page.nextBefore : undefined;
			failedBefore = undefined;
			olderState = 'ready';
			await tick();
			restoreReadingAnchor(feed, anchor);
		} catch {
			if (!isMounted) return;
			failedBefore = before;
			olderState = 'failed';
		}
	}

	// Fetches the newest window explicitly, so a page that opened at the first unread message never jumps to an older one.
	async function refreshNewest(): Promise<boolean> {
		if (!feed || olderState === 'loading') return false;
		const page = await fetchPage(newestWindowBefore);
		if (!isMounted || !feed) return true;
		const followsNewest = isNearBottom(feed);
		const anchor = followsNewest ? undefined : readingAnchor(feed);
		const knownSeqs = new Set(messages.map((message) => message.seq));
		messages = mergeMessages(messages, page.messages);
		const arrivals = messages.filter((message) => !knownSeqs.has(message.seq));
		for (const message of arrivals) arrived.add(message.seq);
		if (awayFromLatest) unreadArrivals += arrivals.length;
		await tick();
		restoreReadingAnchor(feed, anchor);
		if (followsNewest && arrivals.length > 0) feed.lastElementChild?.scrollIntoView({ block: 'end', behavior: 'smooth' });
		return true;
	}

	const live = liveFeed();
	$effect(() => (opensAtEnd ? live.onRefresh(refreshNewest) : undefined));

	onMount(() => {
		void tick().then(openAtReadingPosition);
	});

	afterNavigate(() => {
		void tick().then(openAtReadingPosition);
	});

	// Scrolling up near the top loads the next older page, without a navigation.
	$effect(() => {
		if (!feed) return;
		const feedElement = feed;
		let previousScrollTop = scrollContainer(feedElement)?.scrollTop ?? 0;
		const onScroll = () => {
			const scrollTop = scrollContainer(feedElement)?.scrollTop ?? 0;
			const movedUp = scrollTop < previousScrollTop;
			previousScrollTop = scrollTop;
			if (movedUp && isNearTop(feedElement) && failedBefore !== olderBefore) void loadOlderMessages();
			measureDistanceFromLatest();
		};
		feedElement.addEventListener('scroll', onScroll, { passive: true });
		window.addEventListener('scroll', onScroll, { passive: true });
		window.addEventListener('resize', measureDistanceFromLatest, { passive: true });
		measureDistanceFromLatest();
		return () => {
			feedElement.removeEventListener('scroll', onScroll);
			window.removeEventListener('scroll', onScroll);
			window.removeEventListener('resize', measureDistanceFromLatest);
		};
	});

	function measureDistanceFromLatest(): void {
		if (!feed || !opensAtEnd) return;
		awayFromLatest = isAwayFromLatest(feed);
		if (!awayFromLatest) unreadArrivals = 0;
	}

	function jumpToLatest(): void {
		feed?.lastElementChild?.scrollIntoView({ block: 'end', behavior: scrollBehavior() });
	}

	// Marks messages read once 60% of one stays on screen, so rendering or a live refresh never marks anything read.
	let lastReadSeq = $derived(readState?.lastReadSeq ?? 0);
	let highestSeenSeq = 0;
	let sendTimer: number | undefined;

	async function sendReadPosition(): Promise<void> {
		if (!readState || highestSeenSeq <= lastReadSeq || document.hidden) return;
		const upToSeq = highestSeenSeq;
		const response = await fetch(`/c/${encodeURIComponent(conversationId)}/read`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(threadRootSeq ? { upToSeq, thread: threadRootSeq } : { upToSeq }),
		}).catch(() => null);
		if (!response?.ok) return;
		lastReadSeq = Math.max(lastReadSeq, upToSeq);
		const { unread } = (await response.json()) as { unread: number };
		if (!threadRootSeq) confirmedUnread.set(conversationId, unread);
	}

	const readObserver =
		typeof IntersectionObserver === 'undefined'
			? null
			: new IntersectionObserver(
					(entries) => {
						for (const entry of entries) {
							if (entry.isIntersecting) highestSeenSeq = Math.max(highestSeenSeq, Number(entry.target.id.replace(/^m-/, '')));
						}
						window.clearTimeout(sendTimer);
						sendTimer = window.setTimeout(sendReadPosition, markReadDelayMs);
					},
					{ threshold: visibleShareToCountAsRead },
				);

	const tracksReading: Attachment<HTMLElement> = (article) => {
		if (!readState || !readObserver) return;
		readObserver.observe(article);
		return () => readObserver.unobserve(article);
	};

	async function copyMessageLink(href: string): Promise<void> {
		const link = new URL(href, location.href).href;
		const copied = await navigator.clipboard.writeText(link).then(
			() => true,
			() => false,
		);
		if (copied) toast.success('Link to message copied');
		else toast.error('Could not copy the link');
	}

	onMount(() => {
		canCopyLinks = Boolean(navigator.clipboard) && window.isSecureContext;
		highestSeenSeq = lastReadSeq;
		const sendWhenVisible = () => {
			if (!document.hidden) void sendReadPosition();
		};
		document.addEventListener('visibilitychange', sendWhenVisible);
		return () => {
			isMounted = false;
			window.clearTimeout(sendTimer);
			readObserver?.disconnect();
			document.removeEventListener('visibilitychange', sendWhenVisible);
		};
	});
</script>

{#snippet inlineReply(reply: Message, continues: boolean, showsDay: boolean)}
	<MessageContent
		message={reply}
		{colorByAuthor}
		{continues}
		{canCopyLinks}
		{fileLink}
		timeLabel={showsDay ? `${dayLabel(reply.time, nowMs)} ${formatClockTime(reply.time)}` : formatClockTime(reply.time)}
		href={messageLink(reply)}
		onCopyLink={copyMessageLink}
	/>
{/snippet}

<div class="relative flex min-h-0 grow flex-col">
	<section class="flex min-h-0 grow flex-col gap-3 overflow-auto page-x pt-3.5 pb-5 max-md:overflow-visible" aria-label="Messages" bind:this={feed}>
		{#if olderBefore !== undefined || keepsExhaustedControl}
			<div class="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1" bind:this={olderControl}>
				{#if olderBefore !== undefined}
					<Button variant="outline" size="sm" disabled={olderState === 'loading'} onclick={loadOlderMessages}>
						{#if olderState === 'loading'}<Spinner />{:else}<ArrowUpIcon aria-hidden="true" />{/if}
						{olderState === 'failed' ? 'Retry older messages' : 'Older messages'}
					</Button>
				{:else}
					<Button variant="outline" size="sm" aria-disabled="true">No older messages</Button>
				{/if}
				<span class="text-[13px] text-dim" role="status" aria-live="polite">
					{olderState === 'loading' ? 'Loading older messages…' : olderState === 'failed' ? 'Could not load older messages.' : ''}
				</span>
			</div>
		{/if}
		{#each days as day (day.label || 'all')}
			<div class="flex flex-col gap-3">
				{#if day.label}
					<h2 class={['sticky -top-3.5 z-10 m-0 flex items-center gap-3 bg-ground py-1 text-[13px] font-normal text-dim max-md:top-14', edgeBleed]}>
						<Separator class="w-4! shrink-0" />
						<time datetime={day.messages[0].time.slice(0, 10)}>{day.label}</time>
						<Separator class="flex-1" />
					</h2>
				{/if}
				{#each day.messages as message, index (message.seq)}
					{@const startsUnread = unreadDividerShown && message.seq === firstUnreadSeq}
					{@const continues = !startsUnread && isContinuation(day.messages, index)}
					{@const isThreadRoot = threadRootSeq !== undefined && message.seq === threadRootSeq}
					{@const isThreadReply = threadRootSeq !== undefined && !isThreadRoot}
					{#if startsUnread}
						<div data-first-unread class="flex scroll-mt-10 items-center gap-3 text-[12px] font-semibold tracking-[0.08em] text-amber uppercase max-md:scroll-mt-18" role="separator" aria-label="New messages">
							<Separator class="flex-1 bg-amber/60" />
							<span>New</span>
						</div>
					{/if}
					<article
						id={messageAnchor(message.seq)}
						data-arrived={arrived.has(message.seq) ? '' : undefined}
						{@attach tracksReading}
						class={[
							'group/message relative flex scroll-mt-10 scroll-mb-6 flex-col gap-0.5 max-md:scroll-mt-18',
							{
								'-mt-2': continues,
								'max-w-[820px]': !isThreadReply,
								'border-t border-row-border pt-3': showsPins && index > 0,
								'thread-root border-l-2 border-amber bg-search-match px-3.5 py-3': isThreadRoot,
								'thread-reply ml-4 max-w-[804px] border-l border-border pl-3.5': isThreadReply,
								target: message.seq === targetSeq,
							},
						]}
					>
						<MessageContent
							{message}
							{colorByAuthor}
							{continues}
							{showsPins}
							{canCopyLinks}
							{threadHref}
							{fileLink}
							timeLabel={visibleTime(message)}
							href={messageLink(message)}
							onCopyLink={copyMessageLink}
						/>
					</article>
					{#if threadHref && message.threadReplies > 0}
						<InlineThread {conversationId} root={message} {nowMs} {feed} threadHref={threadHref(message.seq)} reply={inlineReply} />
					{/if}
					{#if threadRoot && message.seq === threadRoot.seq}
						<div class="flex items-center gap-3 text-[13px] text-dim">
							<Separator class="w-4! shrink-0" />
							<span>{replyCountLabel(threadRoot.threadReplies)}</span>
							<Separator class="flex-1" />
						</div>
					{/if}
				{/each}
			</div>
		{/each}
		{#if messages.length === 0}
			<p class="m-0 font-sans text-[15px] text-dim">{showsPins ? 'Nothing is pinned here yet. Agents pin messages with the pin tool.' : 'No messages yet.'}</p>
		{/if}
		{#if newerMessagesHref || latestMessagesHref}
			<nav class="flex flex-wrap gap-2" aria-label="Newer messages">
				{#if newerMessagesHref}<Button href={newerMessagesHref} variant="outline" size="sm"><ArrowDownIcon aria-hidden="true" />Newer messages</Button>{/if}
				{#if latestMessagesHref}<Button href={latestMessagesHref} variant="outline" size="sm">Jump to latest</Button>{/if}
			</nav>
		{/if}
		<span class="text-[13px] text-dim">Read-only. People's agents post here; this view never does.</span>
	</section>
	{#if opensAtEnd && awayFromLatest}
		<div class="absolute right-7 bottom-4 z-30 flex animate-in items-center gap-2 duration-200 ease-out-quint fade-in slide-in-from-bottom-[6px] max-md:fixed max-md:right-4">
			<Button size="sm" class="shadow-[0_0_0_4px_var(--color-ground)]" onclick={jumpToLatest}>
				{#if unreadArrivals > 0}
					{#key unreadArrivals}<Badge variant="secondary" class="animate-in duration-150 ease-out-quint fade-in-50 zoom-in-90">{newMessagesText(unreadArrivals)}</Badge>{/key}
				{/if}
				Jump to latest <ArrowDownIcon aria-hidden="true" />
			</Button>
		</div>
	{/if}
</div>
