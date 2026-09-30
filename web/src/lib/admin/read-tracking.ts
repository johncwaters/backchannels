const markReadDelayMs = 700;
const visibleShareToCountAsRead = 0.6;
const baseTitleAttribute = 'data-base-title';

let stopTracking: (() => void) | undefined;

function seqOfArticle(article: Element): number {
	return Number(article.id.replace(/^m-/, ''));
}

function sidebarUnreadTotal(): number {
	return [...document.querySelectorAll<HTMLElement>('[data-live="sidebar"] [data-unread]')].reduce((total, row) => total + Number(row.dataset.unread ?? 0), 0);
}

function refreshTitle(): void {
	const root = document.documentElement;
	const baseTitle = root.getAttribute(baseTitleAttribute) ?? document.title.replace(/^\(\d+\+?\) /, '');
	root.setAttribute(baseTitleAttribute, baseTitle);
	const total = sidebarUnreadTotal();
	document.title = total > 0 ? `(${total > 99 ? '99+' : total}) ${baseTitle}` : baseTitle;
}

function clearSidebarBadge(conversationId: string, unread: number): void {
	const row = document.querySelector<HTMLElement>(`[data-live="sidebar"] a[aria-current="page"]`);
	if (!row || !row.getAttribute('href')?.includes(`/admin/c/${encodeURIComponent(conversationId)}`)) return;
	if (unread > 0) return;
	row.removeAttribute('data-unread');
	row.querySelector('[data-unread-badge]')?.remove();
	refreshTitle();
}

function trackReading(): void {
	stopTracking?.();
	document.documentElement.removeAttribute(baseTitleAttribute);
	refreshTitle();
	const feed = document.querySelector<HTMLElement>('[data-read-conversation]');
	if (!feed) return;
	const conversationId = feed.dataset.readConversation!;
	const thread = feed.dataset.readThread ? Number(feed.dataset.readThread) : undefined;
	let lastReadSeq = Number(feed.dataset.lastRead ?? 0);
	let highestSeenSeq = lastReadSeq;
	let sendTimer: number | undefined;

	const send = async () => {
		if (highestSeenSeq <= lastReadSeq || document.hidden) return;
		const upToSeq = highestSeenSeq;
		const response = await fetch(`/admin/c/${encodeURIComponent(conversationId)}/read`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			credentials: 'same-origin',
			body: JSON.stringify(thread ? { upToSeq, thread } : { upToSeq }),
		}).catch(() => null);
		if (!response?.ok) return;
		lastReadSeq = Math.max(lastReadSeq, upToSeq);
		const { unread } = (await response.json()) as { unread: number };
		if (!thread) clearSidebarBadge(conversationId, unread);
	};

	const seen = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (entry.isIntersecting) highestSeenSeq = Math.max(highestSeenSeq, seqOfArticle(entry.target));
			}
			window.clearTimeout(sendTimer);
			sendTimer = window.setTimeout(send, markReadDelayMs);
		},
		{ threshold: visibleShareToCountAsRead },
	);
	const observeArticles = () => {
		for (const article of feed.querySelectorAll('article[id^="m-"]')) seen.observe(article);
	};
	observeArticles();
	const arrivals = new MutationObserver(observeArticles);
	arrivals.observe(feed, { childList: true });
	const sendWhenVisible = () => {
		if (!document.hidden) void send();
	};
	document.addEventListener('visibilitychange', sendWhenVisible);
	stopTracking = () => {
		window.clearTimeout(sendTimer);
		seen.disconnect();
		arrivals.disconnect();
		document.removeEventListener('visibilitychange', sendWhenVisible);
	};
}

const sidebarChanges = new MutationObserver(refreshTitle);

document.addEventListener('astro:page-load', () => {
	trackReading();
	sidebarChanges.disconnect();
	const sidebar = document.querySelector('[data-live="sidebar"]');
	if (sidebar) sidebarChanges.observe(sidebar, { childList: true });
});
