import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));

const { Session, sessionCookieName } = await import('./session.ts');
const { MemoryCookies, MemoryStore } = await import('./test-doubles.ts');

const adminSession = { accessToken: 'access', refreshToken: 'refresh', expiresAt: 1 };

describe('Session', () => {
	it('starts empty and sets no cookie until something is stored', async () => {
		const cookies = new MemoryCookies();
		const session = await Session.load(cookies.asCookies(), new MemoryStore());

		expect(session.has('adminSession')).toBe(false);
		expect(cookies.values.size).toBe(0);
	});

	it('keeps the tokens in the store and only a random id in the cookie', async () => {
		const cookies = new MemoryCookies();
		const store = new MemoryStore();
		const session = await Session.load(cookies.asCookies(), store);

		await session.set('adminSession', adminSession);

		const id = cookies.get(sessionCookieName)!;
		expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(id).not.toContain('access');
		expect(JSON.parse(store.values.get(`app-session:${id}`)!)).toEqual({ adminSession });
		expect((await Session.load(cookies.asCookies(), store)).get('adminSession')).toEqual(adminSession);
	});

	it('ignores a cookie whose id the store does not know', async () => {
		const cookies = new MemoryCookies();
		cookies.set(sessionCookieName, 'planted');
		const store = new MemoryStore();
		const session = await Session.load(cookies.asCookies(), store);

		await session.set('adminSession', adminSession);

		expect(cookies.get(sessionCookieName)).not.toBe('planted');
		expect(store.values.has('app-session:planted')).toBe(false);
	});

	it('moves the data to a new id on regenerate and forgets the old one', async () => {
		const cookies = new MemoryCookies();
		const store = new MemoryStore();
		const session = await Session.load(cookies.asCookies(), store);
		await session.set('adminSession', adminSession);
		const oldId = cookies.get(sessionCookieName)!;

		await session.regenerate();

		const newId = cookies.get(sessionCookieName)!;
		expect(newId).not.toBe(oldId);
		expect(store.values.has(`app-session:${oldId}`)).toBe(false);
		expect(JSON.parse(store.values.get(`app-session:${newId}`)!)).toEqual({ adminSession });
	});

	it('removes the stored data and the cookie on destroy', async () => {
		const cookies = new MemoryCookies();
		const store = new MemoryStore();
		const session = await Session.load(cookies.asCookies(), store);
		await session.set('adminSession', adminSession);

		await session.destroy();

		expect(store.values.size).toBe(0);
		expect(cookies.get(sessionCookieName)).toBeUndefined();
		expect(session.has('adminSession')).toBe(false);
	});
});
