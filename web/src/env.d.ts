declare namespace App {
	interface Locals {
		adminFrame?: import('./lib/admin/api').AdminFrame;
		errorView?: import('./lib/admin/api').ErrorView;
	}
	interface SessionData {
		adminSession: import('./lib/admin/types').AdminSession;
		pendingSignIn: { state: string; codeVerifier: string; nextPath: string };
		newHeadlessKey: import('./lib/admin/types').NewHeadlessKey;
	}
}
