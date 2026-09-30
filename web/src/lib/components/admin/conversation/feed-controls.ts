const awayFromLatestPixels = 400;
const copyFeedbackMs = 1600;
const copyLinkLabel = 'copy link';

let stopWatchingFeed: (() => void) | undefined;

function scrollsItself(feed: HTMLElement): boolean {
	return feed.scrollHeight > feed.clientHeight;
}

function distanceFromLatest(feed: HTMLElement): number {
	if (scrollsItself(feed)) return feed.scrollHeight - feed.scrollTop - feed.clientHeight;
	return feed.getBoundingClientRect().bottom - window.innerHeight;
}

function scrollBehavior(): ScrollBehavior {
	return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

function jumpLabel(unreadArrivals: number): string {
	if (unreadArrivals === 0) return 'Jump to latest';
	return unreadArrivals === 1 ? '1 new message' : `${unreadArrivals} new messages`;
}

function watchFeed(): void {
	stopWatchingFeed?.();
	const feed = document.querySelector<HTMLElement>('[data-live="messages"]');
	const control = document.querySelector<HTMLButtonElement>('[data-jump-to-latest]');
	const label = control?.querySelector<HTMLElement>('[data-jump-label]');
	if (!feed || !control || !label) return;
	const listeners = new AbortController();
	let isAwayFromLatest = false;
	let unreadArrivals = 0;
	const render = () => {
		control.hidden = !isAwayFromLatest;
		label.textContent = jumpLabel(unreadArrivals);
	};
	const measure = () => {
		isAwayFromLatest = distanceFromLatest(feed) > awayFromLatestPixels;
		if (!isAwayFromLatest) unreadArrivals = 0;
		render();
	};
	const countArrivals = () => {
		if (isAwayFromLatest) unreadArrivals += feed.querySelectorAll('article[data-arrived]').length;
		render();
	};
	const arrivals = new MutationObserver(countArrivals);
	arrivals.observe(feed, { childList: true });
	feed.addEventListener('scroll', measure, { passive: true, signal: listeners.signal });
	window.addEventListener('scroll', measure, { passive: true, signal: listeners.signal });
	window.addEventListener('resize', measure, { passive: true, signal: listeners.signal });
	control.addEventListener('click', () => feed.lastElementChild?.scrollIntoView({ block: 'end', behavior: scrollBehavior() }), { signal: listeners.signal });
	stopWatchingFeed = () => {
		listeners.abort();
		arrivals.disconnect();
	};
	measure();
}

function announce(text: string): void {
	const status = document.querySelector<HTMLElement>('[data-copy-status]');
	if (status) status.textContent = text;
}

async function copyMessageLink(button: HTMLButtonElement): Promise<void> {
	const link = new URL(button.dataset.copyLink ?? '', location.href).href;
	const copied = await navigator.clipboard.writeText(link).then(() => true, () => false);
	const feedback = copied ? 'copied' : 'copy failed';
	button.textContent = feedback;
	announce(copied ? 'Link to message copied' : 'Could not copy the link');
	window.setTimeout(() => {
		button.textContent = copyLinkLabel;
	}, copyFeedbackMs);
}

function markClipboardSupport(): void {
	if (navigator.clipboard && window.isSecureContext) document.documentElement.dataset.canCopyLinks = '';
}

document.addEventListener('click', (event) => {
	const button = (event.target as Element | null)?.closest<HTMLButtonElement>('button[data-copy-link]');
	if (button) void copyMessageLink(button);
});

document.addEventListener('astro:page-load', () => {
	markClipboardSupport();
	watchFeed();
});
