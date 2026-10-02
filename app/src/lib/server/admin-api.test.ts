import { isHttpError, isRedirect, type RequestEvent } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminSession } from '#lib/admin/types.ts';

const rpc = vi.hoisted(() => ({
	viewer: vi.fn(),
	serverVersion: vi.fn(),
	changeToken: vi.fn(),
	listConversations: vi.fn(),
	refreshAdminSession: vi.fn(),
}));

vi.mock('cloudflare:workers', () => ({
	env: { ADMIN_API: rpc, CF_VERSION_METADATA: { id: '0123456789abcdef', tag: '' } },
}));

const { adminApiFor, failEndpoint, failPage, loadAdminFrame } = await import('./admin-api.ts');

const liveSession: AdminSession = { accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 3_600_000 };

function fakeEvent(path: string, storedSession: AdminSession | null = liveSession) {
	const destroy = vi.fn(async () => {});
	const set = vi.fn(async () => {});
	const event = {
		url: new URL(path, 'https://app.backchannels.dev'),
		locals: { session: { get: () => storedSession ?? undefined, set, destroy } },
	} as unknown as RequestEvent;
	return { event, destroy, set };
}

function succeedWithEmptyWorkspace(): void {
	rpc.viewer.mockResolvedValue({ ok: true, value: { email: 'ian@example.com', name: 'Ian', workspaceName: 'posthog', isAdmin: false } });
	rpc.serverVersion.mockResolvedValue({ ok: true, value: 'v1' });
	rpc.changeToken.mockResolvedValue({ ok: true, value: 'fixture/1' });
	rpc.listConversations.mockResolvedValue({ ok: true, value: { conversations: [], totals: { public: 0, publicMine: 0, private: 0 } } });
}

async function thrownBy(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => undefined,
		(thrown: unknown) => thrown,
	);
}

beforeEach(() => {
	vi.resetAllMocks();
});

describe('failPage', () => {
	it('ends the session and redirects to sign-in when the grant is no longer valid', async () => {
		const { event, destroy } = fakeEvent('/search?q=deploy');

		const thrown = await thrownBy(failPage(event, 'unauthorized'));

		expect(destroy).toHaveBeenCalled();
		expect(isRedirect(thrown) && thrown.location).toBe(`/login?${new URLSearchParams({ next: '/search?q=deploy' })}`);
	});

	it('answers not_found with 404 and any other rejection with 400', async () => {
		const { event } = fakeEvent('/agents');

		const notFound = await thrownBy(failPage(event, 'not_found'));
		const invalid = await thrownBy(failPage(event, 'invalid'));

		expect(isHttpError(notFound, 404)).toBe(true);
		expect(isHttpError(invalid, 400)).toBe(true);
	});
});

describe('failEndpoint', () => {
	it('answers a dead grant with 401, because a script cannot follow sign-in', async () => {
		const { event, destroy } = fakeEvent('/change-token');

		const thrown = await thrownBy(failEndpoint(event, 'unauthorized'));

		expect(destroy).toHaveBeenCalled();
		expect(isHttpError(thrown, 401)).toBe(true);
	});
});

describe('adminApiFor', () => {
	it('redirects to sign-in without calling the api when there is no session', async () => {
		const { event } = fakeEvent('/', null);

		const thrown = await thrownBy(adminApiFor(event));

		expect(isRedirect(thrown)).toBe(true);
		expect(rpc.viewer).not.toHaveBeenCalled();
	});

	it('refreshes a session about to expire once, even when the layout and page load ask together', async () => {
		const expiring = { ...liveSession, expiresAt: Date.now() + 1_000 };
		const refreshed = { ...liveSession, accessToken: 'fresh' };
		rpc.refreshAdminSession.mockResolvedValue({ ok: true, value: refreshed });
		rpc.viewer.mockResolvedValue({ ok: true, value: {} });
		const { event, set } = fakeEvent('/', expiring);

		const [layoutApi, pageApi] = await Promise.all([adminApiFor(event), adminApiFor(event)]);
		await layoutApi.viewer();
		await pageApi.viewer();

		expect(rpc.refreshAdminSession).toHaveBeenCalledTimes(1);
		expect(set).toHaveBeenCalledWith('adminSession', refreshed);
		expect(rpc.viewer).toHaveBeenCalledWith('fresh');
	});
});

describe('loadAdminFrame', () => {
	it('builds the viewer, versions and sidebar for the scope', async () => {
		succeedWithEmptyWorkspace();
		const { event } = fakeEvent('/agents');

		const frame = await loadAdminFrame(event, await adminApiFor(event), 'mine');

		expect(frame.viewer.email).toBe('ian@example.com');
		expect(frame.versions).toEqual({ web: '01234567', mcp: 'v1' });
		expect(frame.sidebarGroups.map((group) => group.kind)).toEqual(['public', 'private']);
	});

	it('turns a failed viewer lookup into the error for that failure', async () => {
		succeedWithEmptyWorkspace();
		rpc.viewer.mockResolvedValue({ ok: false, error: 'not_found' });
		const { event } = fakeEvent('/');

		const thrown = await thrownBy(adminApiFor(event).then((adminApi) => loadAdminFrame(event, adminApi, 'mine')));

		expect(isHttpError(thrown, 404)).toBe(true);
	});

	it('lets a thrown api error propagate so the 500 page renders', async () => {
		succeedWithEmptyWorkspace();
		rpc.listConversations.mockRejectedValue(new Error('service binding unavailable'));
		const { event } = fakeEvent('/');

		await expect(adminApiFor(event).then((adminApi) => loadAdminFrame(event, adminApi, 'mine'))).rejects.toThrow('service binding unavailable');
	});

	it('shows the mcp version as unknown when only the version lookup throws', async () => {
		succeedWithEmptyWorkspace();
		rpc.serverVersion.mockRejectedValue(new Error('timeout'));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const { event } = fakeEvent('/');

		const frame = await loadAdminFrame(event, await adminApiFor(event), 'mine');

		expect(frame.versions.mcp).toBe('unknown');
	});
});
