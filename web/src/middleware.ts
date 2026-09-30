import type { APIContext, MiddlewareNext } from 'astro';
import { defineMiddleware } from 'astro:middleware';
import { loginHref, normalizePathname } from './lib/admin/helpers';

const signInPaths = new Set(['/login', '/logout', '/admin/callback']);

function isAdminPath(pathname: string): boolean {
	return pathname === '/admin' || pathname.startsWith('/admin/');
}

async function respondToAdminRequest(context: APIContext, next: MiddlewareNext, pathname: string): Promise<Response> {
	const isCallback = pathname === '/admin/callback';
	const hasAdminSession = await context.session?.has('adminSession');
	if (!isCallback && !hasAdminSession) return context.redirect(loginHref(context.url), 302);
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
