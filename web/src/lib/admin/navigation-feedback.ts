import type { TransitionBeforePreparationEvent } from 'astro:transitions/client';

const busyAttribute = 'aria-busy';

let busyElement: Element | null = null;

function progressBar(): HTMLElement | null {
	return document.querySelector<HTMLElement>('[data-route-progress]');
}

function startProgress(): void {
	const bar = progressBar();
	if (!bar) return;
	bar.dataset.state = 'idle';
	void bar.offsetWidth;
	bar.dataset.state = 'running';
}

function finishProgress(): void {
	const bar = progressBar();
	if (bar?.dataset.state === 'running') bar.dataset.state = 'done';
}

const viewParameters = ['thread'];

function isSameView(from: URL, to: URL): boolean {
	return from.pathname === to.pathname && viewParameters.every((name) => from.searchParams.get(name) === to.searchParams.get(name));
}

function searchHeadingFor(form: HTMLFormElement): string | null {
	if (new URL(form.action, location.href).pathname !== '/admin/search') return null;
	const data = new FormData(form);
	const query = [data.get('in'), data.get('q')].filter((part) => typeof part === 'string' && part.trim()).join(' ').trim();
	return query ? `“${query}”` : null;
}

function targetHeading(sourceElement: Element | undefined, from: URL, to: URL): string | null {
	const titled = sourceElement?.closest<HTMLElement>('[data-nav-title]')?.dataset.navTitle;
	if (titled) return titled;
	const form = sourceElement?.closest('form');
	if (form) {
		const searchHeading = searchHeadingFor(form);
		if (searchHeading) return searchHeading;
	}
	const sidebarTitle = sidebarLinkFor(to)?.dataset.navTitle;
	if (sidebarTitle) return to.searchParams.has('thread') ? `Thread in ${sidebarTitle}` : sidebarTitle;
	if (isSameView(from, to)) return document.querySelector('[data-view-heading]')?.textContent ?? null;
	return null;
}

function busyTargetFor(sourceElement: Element | undefined): Element | null {
	if (!sourceElement) return null;
	return sourceElement.closest('form') ?? sourceElement.closest('a');
}

function sidebarLinkFor(to: URL): HTMLAnchorElement | undefined {
	return [...document.querySelectorAll<HTMLAnchorElement>('[data-live="sidebar"] a[href]')].find((link) => new URL(link.href).pathname === to.pathname);
}

function selectSegmentedLink(sourceElement: Element | undefined): void {
	const link = sourceElement?.closest('a');
	const navigation = link?.closest('[data-segmented-links]');
	if (!link || !navigation) return;
	for (const current of navigation.querySelectorAll('[aria-current="page"]')) current.removeAttribute('aria-current');
	link.setAttribute('aria-current', 'page');
}

function showTargetImmediately(heading: string | null, to: URL): void {
	const headingElement = document.querySelector<HTMLElement>('[data-view-heading]');
	if (headingElement && heading) headingElement.textContent = heading;
	document.documentElement.dataset.loadingTitle = heading ? 'known' : 'unknown';
	for (const current of document.querySelectorAll('[data-live="sidebar"] [aria-current="page"]')) current.removeAttribute('aria-current');
	sidebarLinkFor(to)?.setAttribute('aria-current', 'page');
}

function clearLoading(): void {
	delete document.documentElement.dataset.loading;
	delete document.documentElement.dataset.loadingTitle;
	busyElement?.removeAttribute(busyAttribute);
	busyElement = null;
	finishProgress();
}

document.addEventListener('astro:before-preparation', (event) => {
	const { from, to, sourceElement } = event as TransitionBeforePreparationEvent;
	clearLoading();
	startProgress();
	busyElement = busyTargetFor(sourceElement);
	busyElement?.setAttribute(busyAttribute, 'true');
	document.documentElement.dataset.loading = 'page';
	selectSegmentedLink(sourceElement);
	showTargetImmediately(targetHeading(sourceElement, from, to), to);
});

document.addEventListener('astro:after-swap', clearLoading);
document.addEventListener('astro:page-load', clearLoading);
window.addEventListener('pageshow', clearLoading);

document.addEventListener('submit', (event) => {
	const form = event.target as HTMLFormElement;
	if (!form.hasAttribute('data-astro-reload') || event.defaultPrevented) return;
	startProgress();
	form.setAttribute(busyAttribute, 'true');
	document.documentElement.dataset.loading = 'page';
	showTargetImmediately(form.dataset.navTitle ?? null, new URL(form.action));
});
