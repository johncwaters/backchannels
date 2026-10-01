import { messageCountText } from '../../../admin/message-count';

const awayFromLatestPixels = 400;
const copyStatusVisibleMs = 1600;

let clearCopyStatusTimer: number | undefined;

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

export function newMessagesText(unreadArrivals: number): string {
	if (unreadArrivals === 0) return '';
	return unreadArrivals === 1 ? '1 new message' : `${messageCountText(unreadArrivals)} new messages`;
}

function watchFeed(): void {
	stopWatchingFeed?.();
	const feed = document.querySelector<HTMLElement>('[data-live="messages"]');
	const controls = document.querySelector<HTMLElement>('[data-jump-controls]');
	const control = controls?.querySelector<HTMLButtonElement>('[data-jump-to-latest]');
	const arrivalCount = controls?.querySelector<HTMLElement>('[data-new-arrivals]');
	if (!feed || !controls || !control || !arrivalCount) return;
	const listeners = new AbortController();
	let isAwayFromLatest = false;
	let unreadArrivals = 0;
	const render = () => {
		controls.hidden = !isAwayFromLatest;
		arrivalCount.hidden = unreadArrivals === 0;
		arrivalCount.textContent = newMessagesText(unreadArrivals);
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

function announceCopyOutcome(text: string): void {
	const status = document.querySelector<HTMLElement>('[data-copy-status]');
	if (!status) return;
	status.textContent = text;
	window.clearTimeout(clearCopyStatusTimer);
	clearCopyStatusTimer = window.setTimeout(() => {
		status.textContent = '';
	}, copyStatusVisibleMs);
}

async function copyMessageLink(button: HTMLButtonElement): Promise<void> {
	const link = new URL(button.dataset.copyLink ?? '', location.href).href;
	const copied = await navigator.clipboard.writeText(link).then(() => true, () => false);
	announceCopyOutcome(copied ? 'Link to message copied' : 'Could not copy the link');
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
