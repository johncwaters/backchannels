import { isRedirect, type RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));

const session = vi.hoisted(() => ({ hasAdminSession: false }));
vi.mock('#lib/server/session.ts', () => ({
	Session: { load: async () => ({ has: () => session.hasAdminSession }) },
}));

const { handle } = await import('./hooks.server.ts');

interface RequestOptions {
	hasSession?: boolean;
	isDataRequest?: boolean;
}

async function respond(path: string, { hasSession = false, isDataRequest = false }: RequestOptions = {}) {
	session.hasAdminSession = hasSession;
	const event = { url: new URL(path, 'https://app.backchannels.dev'), cookies: {}, locals: {}, isDataRequest } as unknown as RequestEvent;
	const resolve = vi.fn(async () => new Response('<h1>page</h1>'));
	const outcome = await Promise.resolve(handle({ event, resolve })).then(
		(response) => ({ response, thrown: undefined }),
		(thrown: unknown) => ({ response: undefined, thrown }),
	);
	return { ...outcome, resolve };
}

describe('handle', () => {
	it('redirects a page to sign-in when there is no session', async () => {
		const { thrown, resolve } = await respond('/c/general?around=4');

		expect(resolve).not.toHaveBeenCalled();
		expect(isRedirect(thrown) && thrown.location).toBe(`/login?${new URLSearchParams({ next: '/c/general?around=4' })}`);
	});

	it('answers a script endpoint without a session with 401 instead of a sign-in page', async () => {
		for (const path of ['/change-token', '/c/general/read', '/c/general/messages?before=9']) {
			const { response } = await respond(path);
			expect(response?.status).toBe(401);
		}
	});

	it('lets a data request through so its load redirects to sign-in itself', async () => {
		const { resolve } = await respond('/c/general', { isDataRequest: true });

		expect(resolve).toHaveBeenCalled();
	});

	it('serves a page with a session and marks it private, unframeable and unindexed', async () => {
		const { response } = await respond('/agents', { hasSession: true });

		expect(response?.headers.get('cache-control')).toBe('private, no-store');
		expect(response?.headers.get('x-frame-options')).toBe('DENY');
		expect(response?.headers.get('x-robots-tag')).toBe('noindex');
		expect(response?.headers.get('referrer-policy')).toBeNull();
	});

	it('lets sign-in paths and their notices through without a session, and hides the referrer on sign-in', async () => {
		for (const path of ['/login?next=/', '/callback?code=abc', '/logout']) {
			const { response } = await respond(path);
			expect(response?.headers.get('referrer-policy')).toBe('no-referrer');
		}
		for (const path of ['/sign-in-failed', '/signed-out']) {
			const { resolve } = await respond(path);
			expect(resolve).toHaveBeenCalled();
		}
	});

	it('treats a trailing slash as the same path', async () => {
		const { thrown } = await respond('/callback/');

		expect(thrown).toBeUndefined();
	});
});
