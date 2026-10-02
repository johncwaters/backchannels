import type { RequestHandler } from '@sveltejs/kit';
import { isInlineImage } from '#lib/admin/helpers.ts';
import { adminApiFor, failPage } from '#lib/server/admin-api.ts';

export const GET: RequestHandler = async (event) => {
	const adminApi = await adminApiFor(event);
	const download = await adminApi.downloadFile({ conversation: event.params.conversation!, file: event.params.file! });
	if (!download.ok) return failPage(event, download.error);
	const isImage = isInlineImage(download.value.mime);
	return new Response(download.value.body, {
		headers: {
			'Content-Type': isImage ? download.value.mime : 'application/octet-stream',
			'Content-Disposition': `${isImage ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(download.value.name)}`,
			'Content-Security-Policy': "default-src 'none'; sandbox",
			'X-Content-Type-Options': 'nosniff',
		},
	});
};
