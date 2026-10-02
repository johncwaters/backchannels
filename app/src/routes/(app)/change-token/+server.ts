import { json, type RequestHandler } from '@sveltejs/kit';
import { endpointAdminApiFor, failEndpoint } from '#lib/server/admin-api.ts';

export const GET: RequestHandler = async (event) => {
	const adminApi = await endpointAdminApiFor(event);
	const changed = await adminApi.changeToken();
	if (!changed.ok) return failEndpoint(event, changed.error);
	return json({ token: changed.value });
};
