import { RpcError } from './rpc.ts';

const shownHeading = $state<{ href: string; value: string | null }>({ href: '', value: null });

export function showPageHeading(href: string, value: string): void {
	shownHeading.href = href;
	shownHeading.value = value;
}

export function clearPageHeading(href: string, value: string): void {
	if (shownHeading.href === href && shownHeading.value === value) shownHeading.value = null;
}

export function pageHeadingFor(href: string): string | null {
	return shownHeading.href === href ? shownHeading.value : null;
}

export function failureStatus(failure: unknown): number {
	if (!(failure instanceof RpcError)) return 500;
	if (failure.failure === 'not_found') return 404;
	if (failure.failure === 'invalid') return 400;
	return 500;
}

export function firstFailure(...queries: { isError: boolean; error: unknown }[]): unknown {
	return queries.find((query) => query.isError)?.error;
}
