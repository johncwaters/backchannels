import { error, json, type RequestHandler } from '@sveltejs/kit';
import { positiveIntegerFrom } from '#lib/admin/helpers.ts';
import { endpointAdminApiFor, failEndpoint } from '#lib/server/admin-api.ts';

export const POST: RequestHandler = async (event) => {
	if (event.request.headers.get('origin') !== event.url.origin) error(403, 'Cross-site request');
	const adminApi = await endpointAdminApiFor(event);
	const body = (await event.request.json().catch(() => null)) as { upToSeq?: unknown; thread?: unknown } | null;
	const upToSeq = positiveIntegerFrom(String(body?.upToSeq ?? ''));
	const thread = body?.thread === undefined ? undefined : positiveIntegerFrom(String(body.thread));
	if (!upToSeq || (body?.thread !== undefined && !thread)) error(400, 'Request not accepted');
	const marked = await adminApi.markRead({ conversation: event.params.conversation!, upToSeq, ...(thread ? { thread } : {}) });
	if (!marked.ok) return failEndpoint(event, marked.error);
	return json(marked.value);
};
