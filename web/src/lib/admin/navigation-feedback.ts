import type { TransitionBeforePreparationEvent } from 'astro:transitions/client';

const skeletonDelayMs = 140;
const busyAttribute = 'aria-busy';

let skeletonTimer: number | undefined;
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

function clearLoading(): void {
	window.clearTimeout(skeletonTimer);
	delete document.documentElement.dataset.loading;
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
	skeletonTimer = window.setTimeout(() => {
		document.documentElement.dataset.loading = kind;
	}, skeletonDelayMs);
});

document.addEventListener('astro:after-swap', clearLoading);
document.addEventListener('astro:page-load', clearLoading);
window.addEventListener('pageshow', clearLoading);
