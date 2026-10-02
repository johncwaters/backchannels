import { redirect, type RequestHandler } from '@sveltejs/kit';
import { startAdminSignIn } from '#lib/server/sign-in.ts';

export const GET: RequestHandler = async (event) => {
	const signInUrl = await startAdminSignIn(event).catch((failure: unknown) => {
		console.error('Starting admin sign-in failed', failure);
		return null;
	});
	if (!signInUrl) redirect(302, '/sign-in-failed');
	// The sign-in URL comes from the api worker over the service binding, and points at its authorize page.
	redirect(302, signInUrl, { external: true });
};
