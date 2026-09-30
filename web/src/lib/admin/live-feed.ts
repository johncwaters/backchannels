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

function openFeedAtEnd(): void {
	const feed = document.querySelector<HTMLElement>('[data-opens-at-end]');
	if (feed && !location.hash) feed.lastElementChild?.scrollIntoView({ block: 'end' });
}

function openDetailsKeys(region: HTMLElement): Set<string> {
	return new Set([...region.querySelectorAll<HTMLDetailsElement>('details[open] > summary[aria-describedby]')].map((summary) => summary.getAttribute('aria-describedby')!));
}

function reopenDetails(region: HTMLElement, keys: Set<string>): void {
	for (const key of keys) region.querySelector(`summary[aria-describedby="${CSS.escape(key)}"]`)?.parentElement?.setAttribute('open', '');
}

async function refreshLiveRegions(): Promise<void> {
	const regions = [...document.querySelectorAll<HTMLElement>(liveRegionSelector)];
	if (regions.length === 0 || document.hidden) return;
	const requestedUrl = location.href;
	const response = await fetch(requestedUrl, { headers: { accept: 'text/html' }, credentials: 'same-origin' }).catch(() => null);
	if (!response?.ok || response.redirected || location.href !== requestedUrl) return;
	const freshDocument = new DOMParser().parseFromString(await response.text(), 'text/html');
	for (const region of regions) {
		const freshRegion = freshDocument.querySelector<HTMLElement>(`[data-live="${region.dataset.live}"]`);
		if (!freshRegion || freshRegion.innerHTML === region.innerHTML) continue;
		const followsNewest = region.hasAttribute('data-opens-at-end') && isNearBottom(region);
		const scrollTop = region.scrollTop;
		const openKeys = openDetailsKeys(region);
		region.innerHTML = freshRegion.innerHTML;
		region.scrollTop = scrollTop;
		reopenDetails(region, openKeys);
		if (followsNewest) region.lastElementChild?.scrollIntoView({ block: 'end' });
	}
}

function startRefreshing(): void {
	window.clearInterval(refreshTimer);
	if (!document.querySelector(liveRegionSelector)) return;
	refreshTimer = window.setInterval(refreshLiveRegions, refreshIntervalMs);
}

document.addEventListener('astro:page-load', () => {
	openFeedAtEnd();
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
	if (!document.hidden) void refreshLiveRegions();
});
