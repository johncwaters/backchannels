import type { APIContext, MiddlewareNext } from 'astro';
import { defineMiddleware } from 'astro:middleware';
import { isAdminPath, loginHref, normalizePathname } from './lib/admin/helpers';

const signInPaths = new Set(['/login', '/logout', '/admin/callback']);
const errorRoutePatterns = new Set(['/404', '/500']);

async function respondToAdminRequest(context: APIContext, next: MiddlewareNext, pathname: string): Promise<Response> {
	const isCallback = pathname === '/admin/callback';
	if (isCallback || errorRoutePatterns.has(context.routePattern)) return next();
	const hasAdminSession = await context.session?.has('adminSession');
	if (!hasAdminSession) return context.redirect(loginHref(context.url), 302);
	return next();
}

export const onRequest = defineMiddleware(async (context, next) => {
	const pathname = normalizePathname(context.url.pathname);
	const isSignInPath = signInPaths.has(pathname);
	if (!isAdminPath(pathname) && !isSignInPath) return next();
	const response = isAdminPath(pathname) ? await respondToAdminRequest(context, next, pathname) : await next();
	response.headers.set('Cache-Control', 'private, no-store');
	response.headers.set('X-Frame-Options', 'DENY');
	if (!isSignInPath) return response;
	response.headers.set('Referrer-Policy', 'no-referrer');
	return response;
});
