import { error, json, type RequestHandler } from '@sveltejs/kit';
import { positiveIntegerFrom } from '#lib/admin/helpers.ts';
import { conversationPageSize } from '#lib/admin/conversation-page.ts';
import { endpointAdminApiFor, failEndpoint } from '#lib/server/admin-api.ts';

// One page of messages for scripts on the conversation page: older history, and the newest window for live refresh.
export const GET: RequestHandler = async (event) => {
	const adminApi = await endpointAdminApiFor(event);
	const parameter = (name: string) => positiveIntegerFrom(event.url.searchParams.get(name));
	const before = parameter('before');
	const thread = parameter('thread');
	if (!before || (event.url.searchParams.has('thread') && !thread)) error(400, 'Request not accepted');
	const read = await adminApi.readConversation({ conversation: event.params.conversation!, thread, before, limit: conversationPageSize });
	if (!read.ok) return failEndpoint(event, read.error);
	return json(read.value);
};
