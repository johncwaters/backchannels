import { error, json, type RequestHandler } from '@sveltejs/kit';
import type { AdminResult } from '#lib/admin/types.ts';
import { endpointAdminApiFor, failEndpoint, tokenMethods, type AdminApi } from '#lib/server/admin-api.ts';

type BridgedMethod = Exclude<(typeof tokenMethods)[number], 'downloadFile'>;
const bridgedMethods = new Set<string>(tokenMethods.filter((name) => name !== 'downloadFile'));
const maxArguments = 2;

// Lets client-side queries call the AdminApi with the session's token, which stays on the server.
export const POST: RequestHandler = async (event) => {
	if (event.request.headers.get('origin') !== event.url.origin) error(403, 'Cross-site request');
	const method = event.params.method ?? '';
	if (!bridgedMethods.has(method)) error(404, 'Not found');
	const body = (await event.request.json().catch(() => null)) as { args?: unknown } | null;
	const args = Array.isArray(body?.args) ? body.args : [];
	if (args.length > maxArguments) error(400, 'Request not accepted');
	const adminApi = await endpointAdminApiFor(event);
	const call = adminApi[method as BridgedMethod] as unknown as (...rest: unknown[]) => Promise<AdminResult<unknown>>;
	const result = await call(...args);
	if (!result.ok && result.error === 'unauthorized') return failEndpoint(event, result.error);
	return json(result);
};

