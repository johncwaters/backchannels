import { json, type RequestHandler } from '@sveltejs/kit';
import { scopeFrom } from '#lib/admin/helpers.ts';
import { endpointAdminApiFor, failEndpoint, loadAdminFrame } from '#lib/server/admin-api.ts';

export const GET: RequestHandler = async (event) => {
	const adminApi = await endpointAdminApiFor(event);
	return json(await loadAdminFrame(event, adminApi, scopeFrom(event.url), failEndpoint));
};
