export const refreshIntervalMs = 10_000;
export const refreshTimeoutMs = 8_000;
const statusPulseMs = 900;
const nearBottomPixels = 120;
const liveRegionSelector = '[data-live]';
const errorViewSelector = '[data-error-view]';
const focusIdentityAttributes = ['id', 'href', 'data-copy-link', 'aria-describedby', 'name'];

type RefreshOutcome = 'reachable' | 'unreachable' | 'cancelled';

interface FreshPage {
	outcome: RefreshOutcome;
	freshDocument?: Document;
}

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

function focusedElementWithin(region: HTMLElement): HTMLElement | null {
	const focused = document.activeElement;
	if (!(focused instanceof HTMLElement) || focused === region || !region.contains(focused)) return null;
	return focused;
}

function focusSelectorFor(element: HTMLElement): string | null {
	const identifyingAttribute = focusIdentityAttributes.find((attribute) => element.hasAttribute(attribute));
	if (!identifyingAttribute) return null;
	return `${element.localName}[${identifyingAttribute}="${CSS.escape(element.getAttribute(identifyingAttribute)!)}"]`;
}

function refocus(region: HTMLElement, selector: string, matchIndex: number): void {
	const matches = region.querySelectorAll<HTMLElement>(selector);
	(matches[matchIndex] ?? matches[0])?.focus({ preventScroll: true });
}

function replaceRegion(region: HTMLElement, freshRegion: HTMLElement): void {
	const focused = focusedElementWithin(region);
	const focusSelector = focused ? focusSelectorFor(focused) : null;
	if (focused && (!focusSelector || !freshRegion.querySelector(focusSelector))) return;
	const focusMatchIndex = focused && focusSelector ? [...region.querySelectorAll(focusSelector)].indexOf(focused) : 0;
	const followsNewest = region.hasAttribute('data-opens-at-end') && isNearBottom(region);
	const scrollTop = region.scrollTop;
	const openKeys = openDetailsKeys(region);
	const knownIds = new Set([...region.querySelectorAll('[id]')].map((element) => element.id));
	const previousPreviews = previewsByHref(region);
	region.innerHTML = freshRegion.innerHTML;
	markArrivals(region, knownIds, previousPreviews);
	region.scrollTop = scrollTop;
	reopenDetails(region, openKeys);
	if (focusSelector) refocus(region, focusSelector, focusMatchIndex);
	if (followsNewest) region.lastElementChild?.scrollIntoView({ block: 'end', behavior: 'smooth' });
}

function applyFreshRegions(regions: HTMLElement[], freshDocument: Document): void {
	for (const region of regions) {
		const freshRegion = freshDocument.querySelector<HTMLElement>(`[data-live="${region.dataset.live}"]`);
		if (!freshRegion || freshRegion.innerHTML === region.innerHTML) continue;
		replaceRegion(region, freshRegion);
	}
}

async function fetchFreshPage(requestedUrl: string, request: AbortController): Promise<FreshPage> {
	const response = await fetch(requestedUrl, { headers: { accept: 'text/html' }, credentials: 'same-origin', signal: request.signal }).catch(() => null);
	const html = response?.ok && !response.redirected ? await response.text().catch(() => null) : null;
	if (request.signal.reason === 'navigation') return { outcome: 'cancelled' };
	if (!response?.ok) return { outcome: 'unreachable' };
	if (html === null) return { outcome: response.redirected ? 'reachable' : 'unreachable' };
	return { outcome: 'reachable', freshDocument: new DOMParser().parseFromString(html, 'text/html') };
}

function liveRegionsOnPage(): HTMLElement[] {
	if (document.querySelector(errorViewSelector)) return [];
	return [...document.querySelectorAll<HTMLElement>(liveRegionSelector)];
}

function liveStatus(): HTMLElement | null {
	return document.querySelector<HTMLElement>('[data-live-status]');
}

export function installLiveFeed(): () => void {
	const listeners = new AbortController();
	let refreshTimer: number | undefined;
	let inFlightRequest: AbortController | null = null;
	let hasLastRefreshFailed = false;
	let savedSidebarScrollTop = 0;

	function connectionStatusText(): string {
		if (document.hidden) return 'paused';
		return hasLastRefreshFailed ? 'offline' : 'live';
	}

	async function refreshLiveRegions(): Promise<void> {
		const regions = liveRegionsOnPage();
		if (inFlightRequest || regions.length === 0 || document.hidden) return;
		const requestedUrl = location.href;
		const request = new AbortController();
		inFlightRequest = request;
		const timeout = window.setTimeout(() => request.abort('timeout'), refreshTimeoutMs);
		const status = liveStatus();
		if (status) status.dataset.refreshing = '';
		const freshPage = await fetchFreshPage(requestedUrl, request).finally(() => {
			window.clearTimeout(timeout);
			if (inFlightRequest === request) inFlightRequest = null;
		});
		window.setTimeout(() => status?.removeAttribute('data-refreshing'), statusPulseMs);
		if (freshPage.outcome === 'cancelled') return;
		hasLastRefreshFailed = freshPage.outcome === 'unreachable';
		if (status) status.textContent = connectionStatusText();
		if (!freshPage.freshDocument || location.href !== requestedUrl) return;
		applyFreshRegions(regions, freshPage.freshDocument);
	}

	function scheduleNextRefresh(): void {
		window.clearTimeout(refreshTimer);
		if (listeners.signal.aborted || document.documentElement.dataset.loading || liveRegionsOnPage().length === 0) return;
		refreshTimer = window.setTimeout(async () => {
			await refreshLiveRegions();
			scheduleNextRefresh();
		}, refreshIntervalMs);
	}

	function cancelInFlightRefresh(): void {
		inFlightRequest?.abort('navigation');
		inFlightRequest = null;
	}

	const { signal } = listeners;
	document.addEventListener('astro:before-preparation', () => {
		window.clearTimeout(refreshTimer);
		cancelInFlightRefresh();
	}, { signal });
	document.addEventListener('astro:page-load', () => {
		openFeedAtReadingPosition();
		scheduleNextRefresh();
	}, { signal });

	document.addEventListener('astro:before-swap', () => {
		cancelInFlightRefresh();
		savedSidebarScrollTop = document.querySelector<HTMLElement>('[data-live="sidebar"]')?.scrollTop ?? 0;
	}, { signal });

	document.addEventListener('astro:after-swap', () => {
		const sidebar = document.querySelector<HTMLElement>('[data-live="sidebar"]');
		if (sidebar) sidebar.scrollTop = savedSidebarScrollTop;
	}, { signal });

	document.addEventListener('visibilitychange', () => {
		const status = liveStatus();
		status?.toggleAttribute('data-paused', document.hidden);
		if (status) status.textContent = connectionStatusText();
		if (!document.hidden) void refreshLiveRegions();
	}, { signal });

	return () => {
		listeners.abort();
		window.clearTimeout(refreshTimer);
		cancelInFlightRefresh();
	};
}
