import type { Cookies } from '@sveltejs/kit';
import type { SessionStore } from './session.ts';

export class MemoryStore implements SessionStore {
	readonly values = new Map<string, string>();
	async get(key: string): Promise<string | null> {
		return this.values.get(key) ?? null;
	}
	async put(key: string, value: string): Promise<void> {
		this.values.set(key, value);
	}
	async delete(key: string): Promise<void> {
		this.values.delete(key);
	}
}

export class MemoryCookies {
	readonly values = new Map<string, string>();
	get(name: string): string | undefined {
		return this.values.get(name);
	}
	set(name: string, value: string): void {
		this.values.set(name, value);
	}
	delete(name: string): void {
		this.values.delete(name);
	}
	asCookies(): Cookies {
		return this as unknown as Cookies;
	}
}
