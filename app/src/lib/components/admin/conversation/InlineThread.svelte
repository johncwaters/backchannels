<script lang="ts">
	import { onMount, tick, untrack, type Snippet } from 'svelte';
	import type { Attachment } from 'svelte/attachments';
	import { quintOut } from 'svelte/easing';
	import { fly, slide } from 'svelte/transition';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import ChevronUpIcon from '@lucide/svelte/icons/chevron-up';
	import { dayLabel, formatRelative, replyCountLabel } from '#lib/admin/helpers.ts';
	import { messageCountText } from '#lib/admin/message-count.ts';
	import type { Message } from '#lib/admin/types.ts';
	import { forgetExpandedThread, rememberExpandedThread, shownRepliesWhenExpanded } from '#lib/client/expanded-threads.ts';
	import { readingAnchor, restoreReadingAnchor } from '#lib/client/feed-scroll.ts';
	import { motionMs } from '#lib/client/motion.ts';
	import { rpc } from '#lib/client/rpc.ts';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Skeleton } from '#lib/components/ui/skeleton/index.ts';
	import { Spinner } from '#lib/components/ui/spinner/index.ts';
	import { continuesPreviousMessage } from './message-grouping';

	interface Props {
		conversationId: string;
		root: Message;
		nowMs: number;
		threadHref: string;
		feed?: HTMLElement;
		reply: Snippet<[message: Message, continues: boolean, showsDay: boolean]>;
	}

	let { conversationId, root, nowMs, threadHref, feed, reply }: Props = $props();

	const replyPageSize = 10;
	const mostRestoredReplies = 200;
	const markReadDelayMs = 700;
	const visibleShareToCountAsRead = 0.6;
	const loadingRowWidths = [64, 48, 72];
	const panelMotionMs = 240;
	const replyMotionMs = 200;
	const replyStaggerMs = 30;
	const longestReplyStaggerMs = 240;
	const replyRisePx = -6;

	let expanded = $state(false);
	let replies = $state<Message[]>([]);
	let moreAfter = $state<number>();
	let hasLoaded = $state(false);
	let loadState = $state<'ready' | 'loading' | 'failed'>('ready');
	let retryLoad: (() => Promise<void>) | undefined;
	let exhaustedAtReplyCount: number | undefined;
	let toggleButton = $state<HTMLButtonElement>();
	let isMounted = true;
	let isRestoring = true;
	const entranceOrderBySeq = new Map<number, number>();

	let threadLastReadSeq = 0;
	let highestSeenSeq = 0;
	let sendTimer: number | undefined;
	let markedUnread = $state<{ forRootCounts: string; count: number }>();

	let repliesId = $derived(`thread-replies-${root.seq}`);
	let rootCounts = $derived(`${root.threadReplies}/${root.unreadReplies}`);
	let markedUnreadReplies = $derived(markedUnread?.forRootCounts === rootCounts ? markedUnread.count : 0);
	let unreadReplies = $derived(Math.max(0, root.unreadReplies - markedUnreadReplies));
	let lastLoadedSeq = $derived(replies.at(-1)?.seq ?? root.seq);
	let repliesLeft = $derived(Math.max(0, root.threadReplies - replies.length));
	let showMoreLabel = $derived(repliesLeft > 0 ? `Show ${Math.min(replyPageSize, repliesLeft)} more (${messageCountText(repliesLeft)} left)` : 'Show more replies');
	let rootDay = $derived(dayLabel(root.time, nowMs));

	async function loadReplies(after: number, limit: number, keepsReadingPosition = false): Promise<void> {
		if (loadState === 'loading') return;
		loadState = 'loading';
		retryLoad = () => loadReplies(after, limit, keepsReadingPosition);
		try {
			const page = await rpc('readConversation', { conversation: conversationId, thread: root.seq, after, limit });
			if (!isMounted) return;
			const anchor = keepsReadingPosition && feed ? readingAnchor(feed) : undefined;
			const loadedSeqs = new Set(replies.map((message) => message.seq));
			const added = page.messages.filter((message) => message.seq !== root.seq && !loadedSeqs.has(message.seq));
			added.forEach((message, order) => entranceOrderBySeq.set(message.seq, order));
			replies = [...replies, ...added];
			moreAfter = page.nextAfter;
			threadLastReadSeq = Math.max(threadLastReadSeq, page.lastReadSeq);
			highestSeenSeq = Math.max(highestSeenSeq, threadLastReadSeq);
			exhaustedAtReplyCount = added.length === 0 ? root.threadReplies : undefined;
			hasLoaded = true;
			loadState = 'ready';
			if (expanded) rememberExpandedThread(conversationId, root.seq, replies.length);
			await tick();
			if (feed) restoreReadingAnchor(feed, anchor);
		} catch {
			if (isMounted) loadState = 'failed';
		}
	}

	function threadMotionMs(milliseconds: number): number {
		return isRestoring ? 0 : motionMs(milliseconds);
	}

	function replyEntranceDelayMs(seq: number): number {
		return threadMotionMs(Math.min(longestReplyStaggerMs, (entranceOrderBySeq.get(seq) ?? 0) * replyStaggerMs));
	}

	function expand(): void {
		isRestoring = false;
		expanded = true;
		rememberExpandedThread(conversationId, root.seq, Math.max(replies.length, replyPageSize));
		if (!hasLoaded) void loadReplies(root.seq, replyPageSize);
	}

	function collapse(returnsFocus: boolean): void {
		expanded = false;
		forgetExpandedThread(conversationId, root.seq);
		if (returnsFocus) toggleButton?.focus();
	}

	function showMoreReplies(): void {
		if (moreAfter !== undefined) void loadReplies(moreAfter, replyPageSize);
	}

	function retry(): void {
		void retryLoad?.();
	}

	$effect(() => {
		const replyCount = root.threadReplies;
		if (!expanded || !hasLoaded || moreAfter !== undefined || loadState !== 'ready') return;
		if (replyCount <= replies.length || replyCount === exhaustedAtReplyCount) return;
		untrack(() => void loadReplies(lastLoadedSeq, replyPageSize, true));
	});

	async function sendThreadReadPosition(): Promise<void> {
		if (highestSeenSeq <= threadLastReadSeq || document.hidden) return;
		const upToSeq = highestSeenSeq;
		const response = await fetch(`/c/${encodeURIComponent(conversationId)}/read`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ upToSeq, thread: root.seq }),
		}).catch(() => null);
		if (!response?.ok || !isMounted || upToSeq <= threadLastReadSeq) return;
		const newlyReadReplies = replies.filter((message) => message.seq > threadLastReadSeq && message.seq <= upToSeq && !message.isOwn && !message.deleted).length;
		threadLastReadSeq = upToSeq;
		markedUnread = { forRootCounts: rootCounts, count: markedUnreadReplies + newlyReadReplies };
	}

	const readObserver =
		typeof IntersectionObserver === 'undefined'
			? null
			: new IntersectionObserver(
					(entries) => {
						for (const entry of entries) {
							if (entry.isIntersecting) highestSeenSeq = Math.max(highestSeenSeq, Number((entry.target as HTMLElement).dataset.seq));
						}
						window.clearTimeout(sendTimer);
						sendTimer = window.setTimeout(sendThreadReadPosition, markReadDelayMs);
					},
					{ threshold: visibleShareToCountAsRead },
				);

	const tracksReading: Attachment<HTMLElement> = (article) => {
		if (!readObserver) return;
		readObserver.observe(article);
		return () => readObserver.unobserve(article);
	};

	onMount(() => {
		const restoredReplies = shownRepliesWhenExpanded(conversationId, root.seq);
		if (restoredReplies !== undefined) {
			expanded = true;
			void loadReplies(root.seq, Math.min(Math.max(restoredReplies, replyPageSize), mostRestoredReplies)).finally(() => {
				isRestoring = false;
			});
		} else {
			isRestoring = false;
		}
		const sendWhenVisible = () => {
			if (!document.hidden) void sendThreadReadPosition();
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

<div class="-mt-2 flex max-w-[820px] flex-col">
	<div
		class="group/thread relative flex flex-wrap items-center gap-x-3 gap-y-1 self-start border-l-2 border-amber bg-search-match px-3 py-1.5 text-[13px] hover:bg-secondary has-[button:focus-visible]:outline-2 has-[button:focus-visible]:outline-offset-2 has-[button:focus-visible]:outline-amber max-md:min-h-11"
	>
		<button
			bind:this={toggleButton}
			type="button"
			class="flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 border-0 bg-transparent p-0 text-left font-mono text-[13px] text-foreground after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
			aria-expanded={expanded}
			aria-controls={repliesId}
			onclick={() => (expanded ? collapse(false) : expand())}
		>
			<ChevronRightIcon class={['size-3.5 shrink-0 text-amber transition-transform duration-150 ease-out-quint', expanded && 'rotate-90']} aria-hidden="true" />
			{#if unreadReplies > 0}<Badge class="rounded-none bg-amber px-1.5 py-0 text-[11px] text-ground">{messageCountText(unreadReplies)} new</Badge>{/if}
			<span class="font-semibold text-amber">{replyCountLabel(root.threadReplies)}</span>
			{#if root.lastReplyAt}<span class="text-dim">· last reply {formatRelative(root.lastReplyAt, nowMs)} ago</span>{/if}
		</button>
		<a class="relative z-[1] text-dim no-underline underline-offset-3 hover:text-foreground hover:underline max-md:inline-flex max-md:min-h-11 max-md:items-center" href={threadHref}>Open thread</a>
	</div>
	{#if expanded}
		<div
			id={repliesId}
			role="group"
			aria-label={`Replies to ${root.person}/${root.agent}`}
			class="mt-2 ml-4 flex flex-col gap-3 border-l border-border pl-3.5"
			transition:slide={{ duration: threadMotionMs(panelMotionMs), easing: quintOut }}
		>
			{#each replies as message, index (message.seq)}
				{@const continues = continuesPreviousMessage(message, replies[index - 1], {})}
				<article
					id={`r-${message.seq}`}
					data-seq={message.seq}
					{@attach tracksReading}
					in:fly={{ y: replyRisePx, duration: threadMotionMs(replyMotionMs), delay: replyEntranceDelayMs(message.seq), easing: quintOut }}
					class={['group/message relative flex max-w-[804px] scroll-mt-10 scroll-mb-6 flex-col gap-0.5 max-md:scroll-mt-18', { '-mt-2': continues }]}
				>
					{@render reply(message, continues, dayLabel(message.time, nowMs) !== rootDay)}
				</article>
			{/each}
			{#if loadState === 'loading' && replies.length === 0}
				{#each loadingRowWidths as width, index (index)}
					<div class="flex flex-col gap-2" aria-hidden="true">
						<Skeleton class="h-3.5 w-40 rounded-none bg-secondary" />
						<Skeleton class="h-4 rounded-none bg-secondary/70" style={`width: ${width}%`} />
					</div>
				{/each}
			{/if}
			<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
				{#if loadState === 'failed'}
					<Button variant="outline" size="sm" class="max-md:min-h-11" onclick={retry}>Retry replies</Button>
				{:else if moreAfter !== undefined}
					<Button variant="outline" size="sm" class="max-md:min-h-11" disabled={loadState === 'loading'} onclick={showMoreReplies}>
						{#if loadState === 'loading'}<Spinner />{/if}
						{showMoreLabel}
					</Button>
				{/if}
				<Button variant="ghost" size="sm" class="text-dim max-md:min-h-11" aria-controls={repliesId} onclick={() => collapse(true)}>
					<ChevronUpIcon aria-hidden="true" />Collapse
				</Button>
				<Button href={threadHref} variant="link" size="sm" class="px-0 text-dim max-md:min-h-11">Open thread</Button>
				<span class="text-[13px] text-dim" role="status" aria-live="polite">
					{loadState === 'loading' ? 'Loading replies…' : loadState === 'failed' ? 'Could not load replies.' : ''}
				</span>
			</div>
		</div>
	{/if}
</div>
