const nearTopPixels = 120;
const pageTimeoutMs = 8_000;
const articleSelector = 'article[id^="m-"]';
const daySelector = '[data-message-day]';
const rowSelector = '[data-message-row]';

interface ReadingAnchor {
	id: string;
	top: number;
}

function scrollContainer(feed: HTMLElement): HTMLElement | null {
	const overflow = getComputedStyle(feed).overflowY;
	return overflow === 'auto' || overflow === 'scroll' ? feed : document.scrollingElement as HTMLElement | null;
}

export function readingAnchor(feed: HTMLElement): ReadingAnchor | undefined {
	const scroller = scrollContainer(feed);
	const top = scroller === feed ? feed.getBoundingClientRect().top : 0;
	const bottom = scroller === feed ? feed.getBoundingClientRect().bottom : window.innerHeight;
	const article = [...feed.querySelectorAll<HTMLElement>(articleSelector)].find((message) => {
		const bounds = message.getBoundingClientRect();
		return bounds.bottom > top && bounds.top < bottom;
	});
	return article ? { id: article.id, top: article.getBoundingClientRect().top } : undefined;
}

export function restoreReadingAnchor(feed: HTMLElement, anchor: ReadingAnchor | undefined): void {
	if (!anchor) return;
	const article = feed.querySelector<HTMLElement>(`#${CSS.escape(anchor.id)}`);
	const scroller = scrollContainer(feed);
	if (article && scroller) scroller.scrollTop += article.getBoundingClientRect().top - anchor.top;
}

function rowSequence(row: Element): number {
	return Number(row.getAttribute('data-message-row'));
}

function prependDays(feed: HTMLElement, source: HTMLElement, acceptsRow: (row: HTMLElement) => boolean): number {
	let added = 0;
	for (const sourceDay of source.querySelectorAll<HTMLElement>(daySelector)) {
		const rows = [...sourceDay.querySelectorAll<HTMLElement>(rowSelector)].filter(acceptsRow);
		if (rows.length === 0) continue;
		added += rows.length;
		const date = sourceDay.dataset.messageDay!;
		const existingDay = feed.querySelector<HTMLElement>(`[data-message-day="${CSS.escape(date)}"]`);
		if (existingDay) {
			const firstRow = existingDay.querySelector(rowSelector);
			for (const row of rows) existingDay.insertBefore(row.cloneNode(true), firstRow);
			continue;
		}
		const day = sourceDay.cloneNode(true) as HTMLElement;
		for (const row of day.querySelectorAll<HTMLElement>(rowSelector)) {
			if (!acceptsRow(row)) row.remove();
		}
		const nextDay = [...feed.querySelectorAll<HTMLElement>(daySelector)].find((candidate) => candidate.dataset.messageDay! > date);
		const lastDay = [...feed.querySelectorAll(daySelector)].at(-1);
		if (nextDay) feed.insertBefore(day, nextDay);
		else if (lastDay) feed.insertBefore(day, lastDay.nextSibling);
		else feed.insertBefore(day, feed.querySelector('[data-older-messages]')?.nextSibling ?? null);
	}
	return added;
}

export function preserveLoadedMessages(feed: HTMLElement, freshFeed: HTMLElement): void {
	if (!feed.hasAttribute('data-message-feed') || !freshFeed.hasAttribute('data-message-feed')) return;
	const firstFreshRow = freshFeed.querySelector(rowSelector);
	if (!firstFreshRow) return;
	const firstFreshSeq = rowSequence(firstFreshRow);
	const retained = prependDays(freshFeed, feed, (row) => rowSequence(row) < firstFreshSeq);
	if (retained === 0) return;
	if (feed.dataset.olderHref) freshFeed.dataset.olderHref = feed.dataset.olderHref;
	else freshFeed.removeAttribute('data-older-href');
	const olderControl = feed.querySelector('[data-older-messages]');
	const freshControl = freshFeed.querySelector('[data-older-messages]');
	if (olderControl && freshControl) freshControl.replaceWith(olderControl.cloneNode(true));
}

function setPaginationState(feed: HTMLElement, state: 'loading' | 'ready' | 'failed'): void {
	const anchor = readingAnchor(feed);
	const control = feed.querySelector<HTMLElement>('[data-older-messages]');
	const link = control?.querySelector<HTMLAnchorElement>('a');
	const status = control?.querySelector<HTMLElement>('[data-pagination-status]');
	const loading = state === 'loading';
	feed.toggleAttribute('data-pagination-loading', loading);
	if (loading) {
		link?.setAttribute('aria-busy', 'true');
		link?.setAttribute('aria-disabled', 'true');
	} else {
		link?.removeAttribute('aria-busy');
		link?.removeAttribute('aria-disabled');
	}
	if (status) status.textContent = loading ? 'Loading older messages…' : state === 'failed' ? 'Could not load older messages. Try again.' : '';
	restoreReadingAnchor(feed, anchor);
}

function updateOlderLink(feed: HTMLElement, olderHref: string | undefined): void {
	if (olderHref) feed.dataset.olderHref = olderHref;
	else feed.removeAttribute('data-older-href');
	const control = feed.querySelector<HTMLElement>('[data-older-messages]');
	const link = control?.querySelector<HTMLAnchorElement>('a');
	if (link && olderHref) link.setAttribute('href', olderHref);
	if (!control || olderHref) return;
	if (control.contains(document.activeElement) && link) {
		link.removeAttribute('href');
		link.setAttribute('tabindex', '0');
		link.setAttribute('aria-disabled', 'true');
		link.textContent = 'No older messages';
	} else control.hidden = true;
}

function isNearTop(feed: HTMLElement): boolean {
	const scroller = scrollContainer(feed);
	if (scroller === feed) return feed.scrollTop < nearTopPixels;
	const bounds = feed.getBoundingClientRect();
	return bounds.top > -nearTopPixels && bounds.bottom > 0;
}

export function installOlderMessages(): () => void {
	const feed = document.querySelector<HTMLElement>('[data-message-feed]');
	if (!feed) return () => {};
	const listeners = new AbortController();
	let request: AbortController | undefined;
	let failedHref: string | undefined;
	let previousScrollTop = scrollContainer(feed)?.scrollTop ?? 0;

	async function loadOlderMessages(): Promise<void> {
		const olderHref = feed!.dataset.olderHref;
		if (!olderHref || request || document.documentElement.dataset.loading) return;
		const requestedUrl = location.href;
		const currentRequest = new AbortController();
		request = currentRequest;
		setPaginationState(feed!, 'loading');
		const timeout = window.setTimeout(() => currentRequest.abort('timeout'), pageTimeoutMs);
		try {
			const response = await fetch(olderHref, { headers: { accept: 'text/html' }, credentials: 'same-origin', signal: currentRequest.signal });
			if (!response.ok || response.redirected) throw new Error('Older message page unavailable');
			const page = new DOMParser().parseFromString(await response.text(), 'text/html');
			if (listeners.signal.aborted || requestedUrl !== location.href || !feed!.isConnected) return;
			const olderFeed = page.querySelector<HTMLElement>('[data-message-feed]');
			if (!olderFeed || olderFeed.dataset.readConversation !== feed!.dataset.readConversation || olderFeed.dataset.readThread !== feed!.dataset.readThread) throw new Error('Older message page does not match');
			const anchor = readingAnchor(feed!);
			const oldest = feed!.querySelector(rowSelector);
			const oldestSeq = oldest ? rowSequence(oldest) : Infinity;
			for (const arrival of feed!.querySelectorAll('[data-arrived]')) arrival.removeAttribute('data-arrived');
			const added = prependDays(feed!, olderFeed, (row) => rowSequence(row) < oldestSeq);
			setPaginationState(feed!, 'ready');
			updateOlderLink(feed!, added > 0 ? olderFeed.dataset.olderHref : undefined);
			restoreReadingAnchor(feed!, anchor);
			failedHref = undefined;
		} catch {
			if (listeners.signal.aborted) return;
			failedHref = olderHref;
			setPaginationState(feed!, 'failed');
		} finally {
			window.clearTimeout(timeout);
			if (request === currentRequest) request = undefined;
			previousScrollTop = scrollContainer(feed!)?.scrollTop ?? 0;
		}
	}

	const { signal } = listeners;
	const onScroll = () => {
		const scrollTop = scrollContainer(feed)?.scrollTop ?? 0;
		const movedUp = scrollTop < previousScrollTop;
		previousScrollTop = scrollTop;
		if (movedUp && isNearTop(feed) && failedHref !== feed.dataset.olderHref) void loadOlderMessages();
	};
	feed.addEventListener('scroll', onScroll, { passive: true, signal });
	window.addEventListener('scroll', onScroll, { passive: true, signal });
	document.addEventListener('click', (event) => {
		const link = (event.target as Element | null)?.closest<HTMLAnchorElement>('[data-older-messages] a');
		if (!link || !feed.contains(link) || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		event.preventDefault();
		void loadOlderMessages();
	}, { capture: true, signal });
	return () => {
		listeners.abort();
		request?.abort('navigation');
	};
}
