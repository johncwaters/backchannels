import { redirect, type RequestHandler } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { endAdminSession } from '#lib/server/sign-in.ts';

// The landing page lives on another host, so the redirect names that one origin as allowed.
function redirectToSite(status: 302 | 303): never {
	redirect(status, env.SITE_URL, { external: [new URL(env.SITE_URL).origin] });
}

// GET only goes home, so a link can never sign anyone out.
export const GET: RequestHandler = () => redirectToSite(302);

export const POST: RequestHandler = async (event) => {
	const isServerSessionEnded = await endAdminSession(event);
	if (!isServerSessionEnded) redirect(303, '/signed-out');
	redirectToSite(303);
};
