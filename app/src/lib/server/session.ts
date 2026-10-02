import type { Cookies } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import type { AdminSession, NewHeadlessKey } from '#lib/admin/types.ts';
import { randomBase64Url } from '#lib/admin/pkce.ts';

export interface SessionData {
	adminSession?: AdminSession;
	pendingSignIn?: { state: string; codeVerifier: string; nextPath: string };
	newHeadlessKey?: NewHeadlessKey & { wasRotated: boolean };
}

export const sessionCookieName = 'backchannels-session';
const sessionTtlSeconds = 30 * 24 * 60 * 60;
const sessionKey = (id: string) => `app-session:${id}`;

export interface SessionStore {
	get(key: string): Promise<string | null>;
	put(key: string, value: string, options: { expirationTtl: number }): Promise<void>;
	delete(key: string): Promise<void>;
}

// One carbon unit's browser session. The cookie holds only a random id;
// the admin tokens stay in KV, so page JavaScript never sees them.
export class Session {
	#id: string | null;
	#data: SessionData;
	readonly #cookies: Cookies;
	readonly #store: SessionStore;

	private constructor(id: string | null, data: SessionData, cookies: Cookies, store: SessionStore) {
		this.#id = id;
		this.#data = data;
		this.#cookies = cookies;
		this.#store = store;
	}

	static async load(cookies: Cookies, store: SessionStore = env.SESSION): Promise<Session> {
		const id = cookies.get(sessionCookieName) ?? null;
		const stored = id ? await store.get(sessionKey(id)) : null;
		const data = stored ? (JSON.parse(stored) as SessionData) : {};
		return new Session(stored ? id : null, data, cookies, store);
	}

	get<Key extends keyof SessionData>(key: Key): SessionData[Key] {
		return this.#data[key];
	}

	has(key: keyof SessionData): boolean {
		return this.#data[key] !== undefined;
	}

	async set<Key extends keyof SessionData>(key: Key, value: SessionData[Key]): Promise<void> {
		this.#data[key] = value;
		await this.#save();
	}

	async delete(key: keyof SessionData): Promise<void> {
		if (!this.has(key)) return;
		delete this.#data[key];
		await this.#save();
	}

	// A new id after sign-in, so an id planted before sign-in never carries the tokens.
	async regenerate(): Promise<void> {
		if (this.#id) await this.#store.delete(sessionKey(this.#id));
		this.#id = null;
		await this.#save();
	}

	async destroy(): Promise<void> {
		if (this.#id) await this.#store.delete(sessionKey(this.#id));
		this.#id = null;
		this.#data = {};
		this.#cookies.delete(sessionCookieName, { path: '/' });
	}

	async #save(): Promise<void> {
		this.#id ??= randomBase64Url(32);
		await this.#store.put(sessionKey(this.#id), JSON.stringify(this.#data), { expirationTtl: sessionTtlSeconds });
		this.#cookies.set(sessionCookieName, this.#id, { path: '/', httpOnly: true, sameSite: 'lax', maxAge: sessionTtlSeconds });
	}
}
