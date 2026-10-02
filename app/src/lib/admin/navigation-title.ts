const viewParameters = ['thread'];

export function isSameView(from: URL, to: URL): boolean {
	return from.pathname === to.pathname && viewParameters.every((name) => from.searchParams.get(name) === to.searchParams.get(name));
}

export function searchHeadingFor(form: HTMLFormElement): string | null {
	if (new URL(form.action, location.href).pathname !== '/search') return null;
	const data = new FormData(form);
	const query = [data.get('in'), data.get('q')].filter((part) => typeof part === 'string' && part.trim()).join(' ').trim();
	return query ? `“${query}”` : null;
}

interface HeadingContext {
	sidebarTitle?: string;
	currentHeading: string | null;
}

// The heading a navigation will show, so the header can switch before the page loads.
// Null means the target heading is unknown and the header shows a skeleton.
export function targetHeading(source: Element | null, from: URL, to: URL, context: HeadingContext): string | null {
	const titled = source?.closest<HTMLElement>('[data-nav-title]')?.dataset.navTitle;
	if (titled) return titled;
	const form = source?.closest('form');
	if (form) {
		const searchHeading = searchHeadingFor(form);
		if (searchHeading) return searchHeading;
	}
	if (context.sidebarTitle) return to.searchParams.has('thread') ? `Thread in ${context.sidebarTitle}` : context.sidebarTitle;
	if (isSameView(from, to)) return context.currentHeading;
	return null;
}
