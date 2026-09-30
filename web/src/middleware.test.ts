import type { APIContext, MiddlewareNext } from 'astro';
import { describe, expect, it, vi } from 'vitest';

vi.mock('astro:middleware', () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

const { onRequest } = await import('./middleware');

interface RequestOptions {
	hasSession?: boolean;
	routePattern?: string;
}

function contextFor(path: string, { hasSession = false, routePattern = new URL(path, 'https://backchannels.dev').pathname }: RequestOptions = {}): APIContext {
	return {
		url: new URL(path, 'https://backchannels.dev'),
		routePattern,
		session: { has: vi.fn(async () => hasSession) },
		redirect: (location: string, status: number) => new Response(null, { status, headers: { location } }),
	} as unknown as APIContext;
}

function pageResponse(status = 200): MiddlewareNext {
	return vi.fn(async () => new Response('<h1>page</h1>', { status })) as unknown as MiddlewareNext;
}

async function respond(context: APIContext, next: MiddlewareNext): Promise<Response> {
	return (await onRequest(context, next)) as Response;
}

describe('middleware', () => {
	it('passes public pages through untouched', async () => {
		const next = pageResponse();

		const response = await respond(contextFor('/'), next);

		expect(next).toHaveBeenCalled();
		expect(response.headers.get('cache-control')).toBeNull();
	});

	it('redirects an admin page to sign-in when there is no session', async () => {
		const next = pageResponse();

		const response = await respond(contextFor('/admin/c/general?around=4'), next);

		expect(next).not.toHaveBeenCalled();
		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toBe(`/login?${new URLSearchParams({ next: '/admin/c/general?around=4' })}`);
	});

	it('serves an admin page with a session and marks it private and unframeable', async () => {
		const response = await respond(contextFor('/admin/agents', { hasSession: true }), pageResponse());

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('private, no-store');
		expect(response.headers.get('x-frame-options')).toBe('DENY');
		expect(response.headers.get('referrer-policy')).toBeNull();
	});

	it('lets the OAuth callback through without a session', async () => {
		const next = pageResponse();

		await respond(contextFor('/admin/callback?code=abc'), next);

		expect(next).toHaveBeenCalled();
	});

	it.each(['/404', '/500'])('renders the %s error page for an admin url instead of redirecting to sign-in', async (routePattern) => {
		const next = pageResponse(Number(routePattern.slice(1)));

		const response = await respond(contextFor('/admin/c/general', { routePattern }), next);

		expect(next).toHaveBeenCalled();
		expect(response.status).toBe(Number(routePattern.slice(1)));
		expect(response.headers.get('cache-control')).toBe('private, no-store');
	});

	it('hides the referrer on sign-in pages', async () => {
		const response = await respond(contextFor('/login?next=/admin'), pageResponse());

		expect(response.headers.get('referrer-policy')).toBe('no-referrer');
		expect(response.headers.get('cache-control')).toBe('private, no-store');
	});

	it('treats a trailing slash as the same admin path', async () => {
		const response = await respond(contextFor('/admin/'), pageResponse());

		expect(response.status).toBe(302);
	});
});
