import { afterNavigate, beforeNavigate } from '$app/navigation';
import { targetHeading } from '#lib/admin/navigation-title.ts';

const busyAttribute = 'aria-busy';
const sourceFreshnessMs = 1_000;

function sidebarTitleFor(to: URL): string | undefined {
	const link = [...document.querySelectorAll<HTMLAnchorElement>('[data-workspace-sidebar] a[href]')].find((candidate) => new URL(candidate.href).pathname === to.pathname);
	return link?.dataset.navTitle;
}

// Shows the target of a client-side navigation at once: the heading it will have, and which link or form started it.
export class NavigationFeedback {
	heading = $state<string | null>(null);
	#source: Element | null = null;
	#sourceAt = 0;
	#busy: Element | null = null;

	// Construct during component initialization, where SvelteKit allows navigation callbacks.
	constructor() {
		beforeNavigate((navigation) => {
			if (!navigation.to || navigation.willUnload) return;
			const source = performance.now() - this.#sourceAt < sourceFreshnessMs ? this.#source : null;
			const from = navigation.from?.url ?? new URL(location.href);
			const currentHeading = document.querySelector('[data-view-heading]')?.textContent ?? null;
			this.clear();
			this.heading = targetHeading(source, from, navigation.to.url, { sidebarTitle: sidebarTitleFor(navigation.to.url), currentHeading });
			this.#busy = source?.closest('form') ?? source?.closest('a') ?? null;
			this.#busy?.setAttribute(busyAttribute, 'true');
		});
		afterNavigate(() => this.clear());
	}

	// Remembers which element the reader clicked or submitted, since a navigation does not say.
	listen(): () => void {
		const remember = (event: Event) => {
			if (!(event.target instanceof Element)) return;
			this.#source = event.target;
			this.#sourceAt = performance.now();
		};
		document.addEventListener('click', remember, true);
		document.addEventListener('submit', remember, true);
		return () => {
			document.removeEventListener('click', remember, true);
			document.removeEventListener('submit', remember, true);
		};
	}

	clear(): void {
		this.#busy?.removeAttribute(busyAttribute);
		this.#busy = null;
		this.#source = null;
	}
}
