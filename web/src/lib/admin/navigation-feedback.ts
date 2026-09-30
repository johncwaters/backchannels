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

function loadingKind(from: URL, to: URL): 'page' | 'position' {
	return from.pathname === to.pathname ? 'position' : 'page';
}

function busyTargetFor(sourceElement: Element | undefined): Element | null {
	if (!sourceElement) return null;
	return sourceElement.closest('form') ?? sourceElement.closest('a');
}

function showTargetImmediately(link: HTMLAnchorElement | null): void {
	const heading = document.querySelector<HTMLElement>('[data-view-heading]');
	const title = link?.dataset.navTitle;
	if (heading && title) heading.textContent = title;
	document.documentElement.dataset.loadingTitle = title ? 'known' : 'unknown';
	const sidebar = link?.closest('[data-live="sidebar"]');
	if (!link || !sidebar) return;
	for (const current of sidebar.querySelectorAll('[aria-current="page"]')) current.removeAttribute('aria-current');
	link.setAttribute('aria-current', 'page');
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
	const kind = loadingKind(from, to);
	document.documentElement.dataset.loading = kind;
	if (kind === 'page') showTargetImmediately(sourceElement?.closest('a') ?? null);
});

document.addEventListener('astro:after-swap', clearLoading);
document.addEventListener('astro:page-load', clearLoading);
window.addEventListener('pageshow', clearLoading);
