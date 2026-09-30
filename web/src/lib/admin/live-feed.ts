const refreshIntervalMs = 10_000;
const nearBottomPixels = 120;
const liveRegionSelector = '[data-live]';

let refreshTimer: number | undefined;
let savedSidebarScrollTop = 0;

function scrollParentOf(element: HTMLElement): HTMLElement | null {
	return element.scrollHeight > element.clientHeight ? element : document.scrollingElement as HTMLElement | null;
}

function isNearBottom(element: HTMLElement): boolean {
	const scroller = scrollParentOf(element);
	if (!scroller) return true;
	return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < nearBottomPixels;
}

function openFeedAtReadingPosition(): void {
	if (location.hash) return;
	const firstUnread = document.querySelector<HTMLElement>('[data-first-unread]');
	if (firstUnread) {
		firstUnread.scrollIntoView({ block: 'start' });
		return;
	}
	const feed = document.querySelector<HTMLElement>('[data-opens-at-end]');
	feed?.lastElementChild?.scrollIntoView({ block: 'end' });
}

function openDetailsKeys(region: HTMLElement): Set<string> {
	return new Set([...region.querySelectorAll<HTMLDetailsElement>('details[open] > summary[aria-describedby]')].map((summary) => summary.getAttribute('aria-describedby')!));
}

function reopenDetails(region: HTMLElement, keys: Set<string>): void {
	for (const key of keys) region.querySelector(`summary[aria-describedby="${CSS.escape(key)}"]`)?.parentElement?.setAttribute('open', '');
}

function previewTextOf(link: HTMLAnchorElement): string {
	return link.querySelector('.preview')?.textContent ?? '';
}

function previewsByHref(region: HTMLElement): Map<string, string> {
	return new Map([...region.querySelectorAll<HTMLAnchorElement>('a.conversation')].map((link) => [link.getAttribute('href') ?? '', previewTextOf(link)]));
}

function markArrivals(region: HTMLElement, knownIds: Set<string>, previousPreviews: Map<string, string>): void {
	for (const article of region.querySelectorAll<HTMLElement>('article[id]')) {
		if (!knownIds.has(article.id)) article.dataset.arrived = '';
	}
	for (const link of region.querySelectorAll<HTMLAnchorElement>('a.conversation')) {
		const previousText = previousPreviews.get(link.getAttribute('href') ?? '');
		if (previousText !== undefined && previousText !== previewTextOf(link)) link.dataset.updated = '';
	}
}

async function refreshLiveRegions(): Promise<void> {
	const regions = [...document.querySelectorAll<HTMLElement>(liveRegionSelector)];
	if (regions.length === 0 || document.hidden) return;
	const requestedUrl = location.href;
	const status = document.querySelector<HTMLElement>('[data-live-status]');
	if (status) status.dataset.refreshing = '';
	const response = await fetch(requestedUrl, { headers: { accept: 'text/html' }, credentials: 'same-origin' }).catch(() => null);
	window.setTimeout(() => status?.removeAttribute('data-refreshing'), 900);
	if (status) status.textContent = response?.ok ? 'live' : 'offline';
	if (!response?.ok || response.redirected || location.href !== requestedUrl) return;
	const freshDocument = new DOMParser().parseFromString(await response.text(), 'text/html');
	for (const region of regions) {
		const freshRegion = freshDocument.querySelector<HTMLElement>(`[data-live="${region.dataset.live}"]`);
		if (!freshRegion || freshRegion.innerHTML === region.innerHTML) continue;
		const followsNewest = region.hasAttribute('data-opens-at-end') && isNearBottom(region);
		const scrollTop = region.scrollTop;
		const openKeys = openDetailsKeys(region);
		const knownIds = new Set([...region.querySelectorAll('[id]')].map((element) => element.id));
		const previousPreviews = previewsByHref(region);
		region.innerHTML = freshRegion.innerHTML;
		markArrivals(region, knownIds, previousPreviews);
		region.scrollTop = scrollTop;
		reopenDetails(region, openKeys);
		if (followsNewest) region.lastElementChild?.scrollIntoView({ block: 'end', behavior: 'smooth' });
	}
}

function startRefreshing(): void {
	window.clearInterval(refreshTimer);
	if (!document.querySelector(liveRegionSelector)) return;
	refreshTimer = window.setInterval(refreshLiveRegions, refreshIntervalMs);
}

document.addEventListener('astro:page-load', () => {
	openFeedAtReadingPosition();
	startRefreshing();
});

document.addEventListener('astro:before-swap', () => {
	savedSidebarScrollTop = document.querySelector<HTMLElement>('[data-live="sidebar"]')?.scrollTop ?? 0;
});

document.addEventListener('astro:after-swap', () => {
	const sidebar = document.querySelector<HTMLElement>('[data-live="sidebar"]');
	if (sidebar) sidebar.scrollTop = savedSidebarScrollTop;
});

document.addEventListener('visibilitychange', () => {
	const status = document.querySelector<HTMLElement>('[data-live-status]');
	status?.toggleAttribute('data-paused', document.hidden);
	if (status) status.textContent = document.hidden ? 'paused' : 'live';
	if (!document.hidden) void refreshLiveRegions();
});
