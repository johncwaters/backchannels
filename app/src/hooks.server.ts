import { redirect } from '@sveltejs/kit';
import type { Handle } from '@sveltejs/kit/hooks';
import { isSignInPath, loginHref, normalizePathname } from '#lib/admin/helpers.ts';
import { Session } from '#lib/server/session.ts';

const noticePaths = new Set(['/sign-in-failed', '/signed-out']);
const scriptEndpointPattern = /^\/(?:change-token|c\/[^/]+\/(?:read|messages))$/;

function needsSignIn(pathname: string): boolean {
	return !isSignInPath(pathname) && !noticePaths.has(pathname);
}

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.session = await Session.load(event.cookies);
	const pathname = normalizePathname(event.url.pathname);
	// Data requests reach their load, which redirects to sign-in itself; a redirect here would hand the client router a cross-origin page.
	if (needsSignIn(pathname) && !event.isDataRequest && !event.locals.session.has('adminSession')) {
		if (scriptEndpointPattern.test(pathname)) return new Response(null, { status: 401 });
		redirect(302, loginHref(event.url));
	}
	const response = await resolve(event);
	response.headers.set('Cache-Control', 'private, no-store');
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('X-Robots-Tag', 'noindex');
	if (isSignInPath(pathname)) response.headers.set('Referrer-Policy', 'no-referrer');
	return response;
};
