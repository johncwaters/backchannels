import { invalidate } from '$app/navigation';
import { loginHref } from '#lib/admin/helpers.ts';

export const refreshIntervalMs = 10_000;
export const refreshTimeoutMs = 8_000;
const statusPulseMs = 900;

export type LiveStatus = 'live' | 'paused' | 'offline';
type RefreshListener = () => Promise<boolean>;

interface LiveFeedOptions {
	isEnabled: () => boolean;
	isNavigating: () => boolean;
}

// Polls the change token 10 seconds after the previous refresh settles, one request at a time, while the tab is visible.
// A changed token reloads the layout data and lets each listener (the open conversation) fetch what it shows.
export class LiveFeed {
	status = $state<LiveStatus>('live');
	refreshing = $state(false);
	#token: string | undefined;
	#listeners = new Set<RefreshListener>();
	#timer: number | undefined;
	#request: AbortController | null = null;
	#hasFailed = false;
	readonly #options: LiveFeedOptions;

	constructor(options: LiveFeedOptions) {
		this.#options = options;
	}

	syncToken(token: string): void {
		this.#token = token;
	}

	onRefresh(listener: RefreshListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	start(): () => void {
		const onVisibility = () => {
			this.#showStatus();
			if (!document.hidden) void this.refresh();
		};
		document.addEventListener('visibilitychange', onVisibility);
		this.#schedule();
		return () => {
			document.removeEventListener('visibilitychange', onVisibility);
			window.clearTimeout(this.#timer);
			this.cancel();
		};
	}

	cancel(): void {
		this.#request?.abort('navigation');
		this.#request = null;
	}

	async refresh(): Promise<void> {
		if (this.#request || !this.#options.isEnabled() || this.#options.isNavigating() || document.hidden) return;
		const request = new AbortController();
		this.#request = request;
		const timeout = window.setTimeout(() => request.abort('timeout'), refreshTimeoutMs);
		this.refreshing = true;
		try {
			const token = await this.#fetchToken(request);
			if (request.signal.aborted && request.signal.reason === 'navigation') return;
			this.#hasFailed = token === null;
			if (token && token !== this.#token) {
				const listenerResults = await Promise.all([invalidate('app:live').then(() => true, () => false), ...[...this.#listeners].map((listener) => listener().catch(() => false))]);
				this.#hasFailed = listenerResults.includes(false);
				this.#token = token;
			}
		} finally {
			window.clearTimeout(timeout);
			if (this.#request === request) this.#request = null;
			window.setTimeout(() => (this.refreshing = false), statusPulseMs);
			this.#showStatus();
		}
	}

	#schedule(): void {
		window.clearTimeout(this.#timer);
		this.#timer = window.setTimeout(async () => {
			await this.refresh();
			this.#schedule();
		}, refreshIntervalMs);
	}

	async #fetchToken(request: AbortController): Promise<string | null> {
		const response = await fetch('/change-token', { headers: { accept: 'application/json' }, cache: 'no-store', signal: request.signal }).catch(() => null);
		if (response?.status === 401) {
			location.assign(loginHref(new URL(location.href)));
			return null;
		}
		const body: unknown = response?.ok ? await response.json().catch(() => null) : null;
		if (!body || typeof body !== 'object' || !('token' in body) || typeof body.token !== 'string') return null;
		return body.token;
	}

	#showStatus(): void {
		this.status = document.hidden ? 'paused' : this.#hasFailed ? 'offline' : 'live';
	}
}
