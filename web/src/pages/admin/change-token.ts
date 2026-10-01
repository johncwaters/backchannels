import type { APIRoute } from 'astro';
import { adminApiFor, failureResponse } from '../../lib/admin/api';

export const prerender = false;

export const GET: APIRoute = async (context) => {
	const adminApi = await adminApiFor(context);
	if (adminApi instanceof Response) return adminApi;
	const changed = await adminApi.changeToken();
	if (!changed.ok) return failureResponse(context, changed.error);
	return Response.json({ token: changed.value });
};
