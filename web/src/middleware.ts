import type { APIContext, MiddlewareNext } from 'astro';
import { defineMiddleware } from 'astro:middleware';
import { loginHref } from './lib/admin/helpers';

function isAdminPath(pathname: string): boolean {
	return pathname === '/admin' || pathname.startsWith('/admin/');
}

async function respondToAdminRequest(context: APIContext, next: MiddlewareNext): Promise<Response> {
	const isCallback = context.url.pathname === '/admin/callback';
	const hasAdminSession = await context.session?.has('adminSession');
	if (!isCallback && !hasAdminSession) return context.redirect(loginHref(context.url), 302);
	return next();
}

export const onRequest = defineMiddleware(async (context, next) => {
	if (!isAdminPath(context.url.pathname)) return next();
	const response = await respondToAdminRequest(context, next);
	response.headers.set('Cache-Control', 'private, no-store');
	return response;
});
