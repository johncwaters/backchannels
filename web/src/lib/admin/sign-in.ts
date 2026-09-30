import type { APIContext } from 'astro';
import { adminRedirectUri, adminRpc } from './api';
import { isServerSessionEnded, sanitizeNextPath, type RevocationOutcome } from './helpers';
import { codeChallengeFor, randomBase64Url } from './pkce';

export async function startAdminSignIn(context: APIContext): Promise<string | null> {
	const state = randomBase64Url(32);
	const codeVerifier = randomBase64Url(48);
	const nextPath = sanitizeNextPath(context.url.searchParams.get('next'));
	context.session?.set('pendingSignIn', { state, codeVerifier, nextPath });
	const signInUrl = await adminRpc().adminSignInUrl({
		redirectUri: adminRedirectUri(context.url),
		state,
		codeChallenge: await codeChallengeFor(codeVerifier),
	});
	if (!signInUrl.ok) return null;
	return signInUrl.value;
}

export async function completeAdminSignIn(context: APIContext): Promise<string | null> {
	const pendingSignIn = await context.session?.get('pendingSignIn');
	context.session?.delete('pendingSignIn');
	const code = context.url.searchParams.get('code');
	const returnedState = context.url.searchParams.get('state');
	if (context.url.searchParams.has('error') || !pendingSignIn || !code || returnedState !== pendingSignIn.state) return null;
	const exchanged = await adminRpc().exchangeAdminCode({
		code,
		codeVerifier: pendingSignIn.codeVerifier,
		redirectUri: adminRedirectUri(context.url),
	});
	if (!exchanged.ok) return null;
	context.session?.set('adminSession', exchanged.value);
	await context.session?.regenerate();
	return pendingSignIn.nextPath;
}

export async function endAdminSession(context: APIContext): Promise<boolean> {
	const adminSession = await context.session?.get('adminSession');
	if (!adminSession) {
		context.session?.destroy();
		return true;
	}
	const revocation: RevocationOutcome = await adminRpc()
		.revokeAdminSession({ refreshToken: adminSession.refreshToken, redirectUri: adminRedirectUri(context.url) })
		.catch((error: unknown) => {
			console.error('Revoking the admin session failed', error);
			return 'unreachable' as const;
		});
	context.session?.destroy();
	return isServerSessionEnded(revocation);
}
