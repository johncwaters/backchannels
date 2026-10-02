import type { RequestEvent } from '@sveltejs/kit';
import { isServerSessionEnded, sanitizeNextPath, type RevocationOutcome } from '#lib/admin/helpers.ts';
import { codeChallengeFor, randomBase64Url } from '#lib/admin/pkce.ts';
import { adminRedirectUri, adminRpc } from './admin-api';

export async function startAdminSignIn(event: RequestEvent): Promise<string | null> {
	const state = randomBase64Url(32);
	const codeVerifier = randomBase64Url(48);
	const nextPath = sanitizeNextPath(event.url.searchParams.get('next'));
	await event.locals.session.set('pendingSignIn', { state, codeVerifier, nextPath });
	const signInUrl = await adminRpc().adminSignInUrl({
		redirectUri: adminRedirectUri(event.url),
		state,
		codeChallenge: await codeChallengeFor(codeVerifier),
	});
	if (!signInUrl.ok) return null;
	return signInUrl.value;
}

export async function completeAdminSignIn(event: RequestEvent): Promise<string | null> {
	const { session } = event.locals;
	const pendingSignIn = session.get('pendingSignIn');
	await session.delete('pendingSignIn');
	const code = event.url.searchParams.get('code');
	const returnedState = event.url.searchParams.get('state');
	if (event.url.searchParams.has('error') || !pendingSignIn || !code || returnedState !== pendingSignIn.state) return null;
	const exchanged = await adminRpc().exchangeAdminCode({
		code,
		codeVerifier: pendingSignIn.codeVerifier,
		redirectUri: adminRedirectUri(event.url),
	});
	if (!exchanged.ok) return null;
	await session.regenerate();
	await session.set('adminSession', exchanged.value);
	return pendingSignIn.nextPath;
}

export async function endAdminSession(event: RequestEvent): Promise<boolean> {
	const { session } = event.locals;
	const adminSession = session.get('adminSession');
	if (!adminSession) {
		await session.destroy();
		return true;
	}
	const revocation: RevocationOutcome = await adminRpc()
		.revokeAdminSession({ refreshToken: adminSession.refreshToken, redirectUri: adminRedirectUri(event.url) })
		.catch((failure: unknown) => {
			console.error('Revoking the admin session failed', failure);
			return 'unreachable' as const;
		});
	await session.destroy();
	return isServerSessionEnded(revocation);
}
