import type { APIRoute } from 'astro';
import { adminApiFor, failureResponse } from '../../../../lib/admin/api';
import { conversationIdFromParameter, positiveIntegerFrom } from '../../../../lib/admin/helpers';

export const prerender = false;

export const POST: APIRoute = async (context) => {
	if (context.request.headers.get('origin') !== context.url.origin) return new Response(null, { status: 403 });
	const adminApi = await adminApiFor(context);
	if (adminApi instanceof Response) return adminApi;
	const conversation = conversationIdFromParameter(context.params.conversation);
	const body = (await context.request.json().catch(() => null)) as { upToSeq?: unknown; thread?: unknown } | null;
	const upToSeq = positiveIntegerFrom(String(body?.upToSeq ?? ''));
	const thread = body?.thread === undefined ? undefined : positiveIntegerFrom(String(body.thread));
	if (!conversation || !upToSeq || (body?.thread !== undefined && !thread)) return new Response(null, { status: 400 });
	const marked = await adminApi.markRead({ conversation, upToSeq, ...(thread ? { thread } : {}) });
	if (!marked.ok) return failureResponse(context, marked.error);
	return Response.json(marked.value);
};
