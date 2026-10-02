declare global {
	namespace App {
		interface Locals {
			session: import('#lib/server/session.ts').Session;
			adminSession?: Promise<import('#lib/admin/types.ts').AdminSession | null>;
		}
		interface Error {
			message: string;
		}
	}
}

export {};
