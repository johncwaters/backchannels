import type { APIContext } from 'astro';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminSession } from './types';

const rpc = vi.hoisted(() => ({
	viewer: vi.fn(),
	serverVersion: vi.fn(),
	listConversations: vi.fn(),
	refreshAdminSession: vi.fn(),
}));

vi.mock('cloudflare:workers', () => ({
	env: { ADMIN_API: rpc, CF_VERSION_METADATA: { id: '0123456789abcdef', tag: '' } },
}));

const { failureResponse, loadAdminFrame } = await import('./api');

const liveSession: AdminSession = { accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 3_600_000 };
const errorPageHtml = '<h1>Link not understood</h1>';

interface FakeContext {
	context: APIContext;
	destroySession: ReturnType<typeof vi.fn>;
	rewrite: ReturnType<typeof vi.fn>;
}

function fakeContext(path: string, storedSession: AdminSession | null = liveSession): FakeContext {
	const url = new URL(path, 'https://backchannels.dev');
	const destroySession = vi.fn();
	const rewrite = vi.fn(async () => new Response(errorPageHtml, { status: 404, headers: { 'content-type': 'text/html' } }));
	const context = {
		url,
		request: new Request(url),
		locals: {},
		session: { get: vi.fn(async () => storedSession ?? undefined), set: vi.fn(), destroy: destroySession },
		redirect: (location: string, status: number) => new Response(null, { status, headers: { location } }),
		rewrite,
	} as unknown as APIContext;
	return { context, destroySession, rewrite };
}

function succeedWithEmptyWorkspace(): void {
	rpc.viewer.mockResolvedValue({ ok: true, value: { email: 'ian@example.com', name: 'Ian', workspaceName: 'posthog', isAdmin: false } });
	rpc.serverVersion.mockResolvedValue({ ok: true, value: 'v1' });
	rpc.listConversations.mockResolvedValue({ ok: true, value: { conversations: [], totals: { public: 0, publicMine: 0, private: 0 } } });
}

beforeEach(() => {
	vi.resetAllMocks();
});

describe('failureResponse', () => {
	it('ends the session and redirects to sign-in when the grant is no longer valid', async () => {
		const { context, destroySession } = fakeContext('/admin/search?q=deploy');

		const response = await failureResponse(context, 'unauthorized');

		expect(destroySession).toHaveBeenCalled();
		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toBe(`/login?${new URLSearchParams({ next: '/admin/search?q=deploy' })}`);
	});

	it('returns an empty 404 so Astro renders the not found page', async () => {
		const { context, rewrite } = fakeContext('/admin/agents');

		const response = await failureResponse(context, 'not_found');

		expect(response.status).toBe(404);
		expect(response.body).toBeNull();
		expect(rewrite).not.toHaveBeenCalled();
	});

	it('renders the error page with status 400 for a request the api rejected', async () => {
		const { context, rewrite } = fakeContext('/admin/browse/public?cursor=bogus&scope=everyone');

		const response = await failureResponse(context, 'invalid');

		expect(rewrite).toHaveBeenCalledWith('/404?cursor=bogus&scope=everyone');
		expect(context.locals.errorView).toEqual({ status: 400 });
		expect(response.status).toBe(400);
		expect(await response.text()).toBe(errorPageHtml);
	});

	it('answers a rejected post whose body was already read with a bare 400 instead of rewriting', async () => {
		const url = new URL('/admin/c/deploys/read', 'https://backchannels.dev');
		const request = new Request(url, { method: 'POST', body: JSON.stringify({ upToSeq: 'bogus' }) });
		await request.json();
		const context = { url, request, locals: {} } as unknown as APIContext;

		const response = await failureResponse(context, 'invalid');

		expect(response.status).toBe(400);
		expect(response.body).toBeNull();
		expect(context.locals.errorView).toBeUndefined();
	});
});

describe('loadAdminFrame', () => {
	it('keeps the loaded frame in locals so error pages can render inside the admin layout', async () => {
		succeedWithEmptyWorkspace();
		const { context } = fakeContext('/admin/agents');

		const loaded = await loadAdminFrame(context, 'mine');

		expect(loaded).not.toBeInstanceOf(Response);
		expect(context.locals.adminFrame?.viewer.email).toBe('ian@example.com');
	});

	it('redirects to sign-in without calling the api when there is no session', async () => {
		const { context } = fakeContext('/admin', null);

		const loaded = await loadAdminFrame(context, 'mine');

		expect(loaded).toBeInstanceOf(Response);
		expect((loaded as Response).status).toBe(302);
		expect(rpc.viewer).not.toHaveBeenCalled();
	});

	it('turns a failed viewer lookup into the error response for that failure', async () => {
		succeedWithEmptyWorkspace();
		rpc.viewer.mockResolvedValue({ ok: false, error: 'not_found' });
		const { context } = fakeContext('/admin');

		const loaded = await loadAdminFrame(context, 'mine');

		expect((loaded as Response).status).toBe(404);
		expect(context.locals.adminFrame).toBeUndefined();
	});

	it('lets a thrown api error propagate so Astro renders the 500 page', async () => {
		succeedWithEmptyWorkspace();
		rpc.listConversations.mockRejectedValue(new Error('service binding unavailable'));
		const { context } = fakeContext('/admin');

		await expect(loadAdminFrame(context, 'mine')).rejects.toThrow('service binding unavailable');
	});

	it('shows the mcp version as unknown when only the version lookup throws', async () => {
		succeedWithEmptyWorkspace();
		rpc.serverVersion.mockRejectedValue(new Error('timeout'));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const { context } = fakeContext('/admin');

		const loaded = await loadAdminFrame(context, 'mine');

		expect(loaded).not.toBeInstanceOf(Response);
		expect(context.locals.adminFrame?.versions.mcp).toBe('unknown');
	});
});
