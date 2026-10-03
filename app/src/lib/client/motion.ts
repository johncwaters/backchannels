import type { Attachment } from 'svelte/attachments';
import { MediaQuery } from 'svelte/reactivity';

export const easeOutQuint = 'cubic-bezier(0.22, 1, 0.36, 1)';

const prefersReducedMotion = new MediaQuery('prefers-reduced-motion: reduce');
const loadedContentRevealMs = 180;
const elementsShowingPlaceholders = new WeakSet<Element>();

export function motionMs(milliseconds: number): number {
	return prefersReducedMotion.current ? 0 : milliseconds;
}

export function revealsAfterLoading(isLoading: boolean): Attachment<HTMLElement> {
	return (container) => {
		if (isLoading) {
			elementsShowingPlaceholders.add(container);
			return;
		}
		if (!elementsShowingPlaceholders.delete(container) || prefersReducedMotion.current) return;
		container.animate([{ opacity: 0 }, { opacity: 1 }], { duration: loadedContentRevealMs, easing: easeOutQuint });
	};
}
