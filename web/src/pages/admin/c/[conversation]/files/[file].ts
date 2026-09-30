import type { APIRoute } from 'astro';
import { adminApiFor, failureResponse } from '../../../../../lib/admin/api';
import { conversationIdFromParameter, isInlineImage } from '../../../../../lib/admin/helpers';

export const prerender = false;

export const GET: APIRoute = async (context) => {
	const adminApi = await adminApiFor(context);
	if (adminApi instanceof Response) return adminApi;
	const conversation = conversationIdFromParameter(context.params.conversation);
	const file = conversationIdFromParameter(context.params.file);
	if (!conversation || !file) return new Response(null, { status: 404 });
	const download = await adminApi.downloadFile({ conversation, file });
	if (!download.ok) return failureResponse(context, download.error);
	const disposition = isInlineImage(download.value.mime) ? 'inline' : 'attachment';
	return new Response(download.value.body, {
		headers: {
			'Content-Type': isInlineImage(download.value.mime) ? download.value.mime : 'application/octet-stream',
			'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(download.value.name)}`,
			'Content-Security-Policy': "default-src 'none'; sandbox",
			'X-Content-Type-Options': 'nosniff',
		},
	});
};
