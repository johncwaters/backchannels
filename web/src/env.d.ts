declare namespace App {
	interface SessionData {
		adminSession: import('./lib/admin/types').AdminSession;
		pendingSignIn: { state: string; codeVerifier: string; nextPath: string };
	}
}
