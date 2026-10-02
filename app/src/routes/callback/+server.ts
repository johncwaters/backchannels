import { redirect, type RequestHandler } from '@sveltejs/kit';
import { completeAdminSignIn } from '#lib/server/sign-in.ts';

// The admin client's OAuth redirect URI: exchanges the code and saves the session.
export const GET: RequestHandler = async (event) => {
	const nextPath = await completeAdminSignIn(event).catch((failure: unknown) => {
		console.error('Completing admin sign-in failed', failure);
		return null;
	});
	redirect(302, nextPath ?? '/sign-in-failed');
};
