import { messageCountText } from '#lib/admin/message-count.ts';

const nearTopPixels = 120;
const nearBottomPixels = 120;
const awayFromLatestPixels = 400;
const articleSelector = 'article[id^="m-"], article[id^="r-"]';

export interface ReadingAnchor {
	id: string;
	top: number;
}

// On a wide screen the feed scrolls itself; on a narrow one the page scrolls.
export function scrollContainer(feed: HTMLElement): HTMLElement | null {
	const overflow = getComputedStyle(feed).overflowY;
	return overflow === 'auto' || overflow === 'scroll' ? feed : (document.scrollingElement as HTMLElement | null);
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

// Keeps the message the reader was looking at in the same place on screen after messages are added above it.
export function restoreReadingAnchor(feed: HTMLElement, anchor: ReadingAnchor | undefined): void {
	if (!anchor) return;
	const article = document.getElementById(anchor.id);
	const scroller = scrollContainer(feed);
	if (article && scroller && feed.contains(article)) scroller.scrollTop += article.getBoundingClientRect().top - anchor.top;
}

export function isNearTop(feed: HTMLElement): boolean {
	const scroller = scrollContainer(feed);
	if (scroller === feed) return feed.scrollTop < nearTopPixels;
	const bounds = feed.getBoundingClientRect();
	return bounds.top > -nearTopPixels && bounds.bottom > 0;
}

export function isNearBottom(feed: HTMLElement): boolean {
	const scroller = scrollContainer(feed);
	if (!scroller) return true;
	return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < nearBottomPixels;
}

export function isAwayFromLatest(feed: HTMLElement): boolean {
	const distance = feed.scrollHeight > feed.clientHeight ? feed.scrollHeight - feed.scrollTop - feed.clientHeight : feed.getBoundingClientRect().bottom - window.innerHeight;
	return distance > awayFromLatestPixels;
}

export function scrollBehavior(): ScrollBehavior {
	return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

export function newMessagesText(unreadArrivals: number): string {
	if (unreadArrivals === 0) return '';
	return unreadArrivals === 1 ? '1 new message' : `${messageCountText(unreadArrivals)} new messages`;
}
