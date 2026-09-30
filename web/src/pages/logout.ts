import type { APIRoute } from 'astro';
import { endAdminSession } from '../lib/admin/sign-in';

export const prerender = false;

export const GET: APIRoute = (context) => context.redirect('/', 302);

export const POST: APIRoute = async (context) => {
	await endAdminSession(context).catch((error: unknown) => console.error('Revoking the admin session failed', error));
	return context.redirect('/', 302);
};
