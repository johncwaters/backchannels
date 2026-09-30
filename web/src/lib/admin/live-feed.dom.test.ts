import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installLiveFeed, refreshIntervalMs, refreshTimeoutMs } from './live-feed';

interface PendingFetch {
	signal: AbortSignal;
	respond: (html: string) => void;
	fail: () => void;
}

interface SidebarRow {
	href: string;
	lastActive: string;
}

let uninstallLiveFeed: (() => void) | undefined;
let isDocumentHidden = false;
let pendingFetches: PendingFetch[] = [];

function sidebarHtml(rows: SidebarRow[]): string {
	return rows.map((row) => `<a class="conversation" href="${row.href}"><span class="last-active">${row.lastActive}</span><span class="preview">hi</span></a>`).join('');
}

function pageHtml(sidebarRows: SidebarRow[]): string {
	return `<!doctype html><html><body><nav data-live="sidebar">${sidebarHtml(sidebarRows)}</nav></body></html>`;
}

function renderPage(sidebarRows: SidebarRow[]): void {
	document.body.innerHTML = `<nav data-live="sidebar">${sidebarHtml(sidebarRows)}</nav><span data-live-status>live</span>`;
}

function sidebarRow(href: string): HTMLAnchorElement {
	return document.querySelector<HTMLAnchorElement>(`a[href="${href}"]`)!;
}

function liveStatusText(): string | null {
	return document.querySelector('[data-live-status]')!.textContent;
}

function setDocumentHidden(isHidden: boolean): void {
	isDocumentHidden = isHidden;
	document.dispatchEvent(new Event('visibilitychange'));
}

function stubPendingFetch(): void {
	vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
		const signal = init.signal!;
		signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
		pendingFetches.push({
			signal,
			respond: (html) => resolve(new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })),
			fail: () => reject(new TypeError('network down')),
		});
	})));
}

async function settle(): Promise<void> {
	await vi.advanceTimersByTimeAsync(0);
}

async function startFeed(): Promise<void> {
	uninstallLiveFeed = installLiveFeed();
	document.dispatchEvent(new Event('astro:page-load'));
	await vi.advanceTimersByTimeAsync(refreshIntervalMs);
}

beforeEach(() => {
	vi.useFakeTimers();
	isDocumentHidden = false;
	pendingFetches = [];
	Object.defineProperty(document, 'hidden', { configurable: true, get: () => isDocumentHidden });
	stubPendingFetch();
});

afterEach(() => {
	uninstallLiveFeed?.();
	uninstallLiveFeed = undefined;
	vi.unstubAllGlobals();
	vi.useRealTimers();
	document.body.innerHTML = '';
	document.body.removeAttribute('data-error-view');
});

describe('live feed focus', () => {
	it('keeps keyboard focus on the same sidebar row after a refresh replaces the sidebar', async () => {
		renderPage([{ href: '/admin/c/deploys', lastActive: '1m' }, { href: '/admin/c/general', lastActive: '3m' }]);
		sidebarRow('/admin/c/general').focus();
		await startFeed();
		const rowBeforeRefresh = sidebarRow('/admin/c/general');

		pendingFetches[0].respond(pageHtml([{ href: '/admin/c/deploys', lastActive: '2m' }, { href: '/admin/c/general', lastActive: '4m' }]));
		await settle();

		const rowAfterRefresh = sidebarRow('/admin/c/general');
		expect(rowAfterRefresh).not.toBe(rowBeforeRefresh);
		expect(rowAfterRefresh.textContent).toContain('4m');
		expect(document.activeElement).toBe(rowAfterRefresh);
	});

	it('keeps the stale sidebar when the focused row is missing from the fresh page', async () => {
		renderPage([{ href: '/admin/c/deploys', lastActive: '1m' }, { href: '/admin/c/general', lastActive: '3m' }]);
		const focusedRow = sidebarRow('/admin/c/general');
		focusedRow.focus();
		await startFeed();

		pendingFetches[0].respond(pageHtml([{ href: '/admin/c/deploys', lastActive: '2m' }]));
		await settle();

		expect(sidebarRow('/admin/c/general')).toBe(focusedRow);
		expect(document.activeElement).toBe(focusedRow);
	});

	it('replaces the sidebar when focus is elsewhere on the page', async () => {
		renderPage([{ href: '/admin/c/deploys', lastActive: '1m' }]);
		await startFeed();

		pendingFetches[0].respond(pageHtml([{ href: '/admin/c/deploys', lastActive: '2m' }]));
		await settle();

		expect(sidebarRow('/admin/c/deploys').textContent).toContain('2m');
	});
});

describe('live feed scheduling', () => {
	it('never starts a second request while one is in flight', async () => {
		renderPage([{ href: '/admin/c/deploys', lastActive: '1m' }]);
		await startFeed();
		expect(fetch).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(refreshTimeoutMs - 1);
		setDocumentHidden(false);
		await settle();
		expect(fetch).toHaveBeenCalledTimes(1);

		pendingFetches[0].respond(pageHtml([{ href: '/admin/c/deploys', lastActive: '2m' }]));
		await settle();
		await vi.advanceTimersByTimeAsync(refreshIntervalMs);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it('waits a full interval after a slow request before starting the next one', async () => {
		renderPage([{ href: '/admin/c/deploys', lastActive: '1m' }]);
		await startFeed();
		await vi.advanceTimersByTimeAsync(refreshTimeoutMs - 1);
		pendingFetches[0].respond(pageHtml([{ href: '/admin/c/deploys', lastActive: '2m' }]));
		await settle();

		await vi.advanceTimersByTimeAsync(refreshIntervalMs - 1);
		expect(fetch).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it('aborts a request that outlives the timeout and reports offline', async () => {
		renderPage([{ href: '/admin/c/deploys', lastActive: '1m' }]);
		await startFeed();

		await vi.advanceTimersByTimeAsync(refreshTimeoutMs);

		expect(pendingFetches[0].signal.aborted).toBe(true);
		expect(liveStatusText()).toBe('offline');
	});

	it('schedules the next refresh after a timed-out request', async () => {
		renderPage([{ href: '/admin/c/deploys', lastActive: '1m' }]);
		await startFeed();
		await vi.advanceTimersByTimeAsync(refreshTimeoutMs);

		await vi.advanceTimersByTimeAsync(refreshIntervalMs);

		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it('cancels the in-flight request on navigation without reporting offline', async () => {
		renderPage([{ href: '/admin/c/deploys', lastActive: '1m' }]);
		await startFeed();

		document.dispatchEvent(new Event('astro:before-swap'));
		await settle();

		expect(pendingFetches[0].signal.aborted).toBe(true);
		expect(liveStatusText()).toBe('live');
	});

	it('stops refreshing once uninstalled', async () => {
		renderPage([{ href: '/admin/c/deploys', lastActive: '1m' }]);
		await startFeed();
		pendingFetches[0].respond(pageHtml([{ href: '/admin/c/deploys', lastActive: '2m' }]));
		await settle();

		uninstallLiveFeed?.();
		await vi.advanceTimersByTimeAsync(refreshIntervalMs * 3);

		expect(fetch).toHaveBeenCalledTimes(1);
	});
});

describe('live feed on error pages', () => {
	it('never polls an error page, so the footer does not flip to offline', async () => {
		renderPage([{ href: '/admin/c/deploys', lastActive: '1m' }]);
		document.body.setAttribute('data-error-view', '');
		await startFeed();
		await vi.advanceTimersByTimeAsync(refreshIntervalMs * 3);
		setDocumentHidden(true);
		setDocumentHidden(false);
		await settle();

		expect(fetch).not.toHaveBeenCalled();
		expect(liveStatusText()).toBe('live');
	});
});

describe('live feed status', () => {
	it('shows offline, not live, when the tab returns after a failed refresh', async () => {
		renderPage([{ href: '/admin/c/deploys', lastActive: '1m' }]);
		await startFeed();
		pendingFetches[0].fail();
		await settle();
		expect(liveStatusText()).toBe('offline');

		setDocumentHidden(true);
		expect(liveStatusText()).toBe('paused');
		setDocumentHidden(false);

		expect(liveStatusText()).toBe('offline');
	});

	it('shows live when the tab returns after a successful refresh', async () => {
		renderPage([{ href: '/admin/c/deploys', lastActive: '1m' }]);
		await startFeed();
		pendingFetches[0].respond(pageHtml([{ href: '/admin/c/deploys', lastActive: '2m' }]));
		await settle();

		setDocumentHidden(true);
		setDocumentHidden(false);

		expect(liveStatusText()).toBe('live');
	});
});
