import { positiveIntegerFrom, scopeFrom, subheadingFor } from '#lib/admin/helpers.ts';
import { conversationPageSize } from '#lib/admin/conversation-page.ts';
import type { AdminResult, Conversation, Message } from '#lib/admin/types.ts';
import { adminApiFor, failPage } from '#lib/server/admin-api.ts';
import type { PageServerLoad } from './$types';

interface ShownMessages {
	conversation: Conversation;
	messages: Message[];
	lastReadSeq?: number;
	firstUnreadSeq?: number;
	nextBefore?: number;
	nextAfter?: number;
}

export const load: PageServerLoad = async (event) => {
	const scope = scopeFrom(event.url);
	const conversationId = event.params.conversation;
	const parameter = (name: string) => positiveIntegerFrom(event.url.searchParams.get(name));
	const thread = parameter('thread');
	const around = parameter('around');
	const after = around ? undefined : parameter('after');
	const before = around || after ? undefined : parameter('before');
	const showsPins = event.url.searchParams.get('view') === 'pins' && !thread;
	const adminApi = await adminApiFor(event);
	const read: AdminResult<ShownMessages> = showsPins
		? await adminApi.listPins({ conversation: conversationId })
		: await adminApi.readConversation({ conversation: conversationId, thread, around, after, before, limit: conversationPageSize });
	if (!read.ok && read.error !== 'not_found') return failPage(event, read.error);
	const nowMs = Date.now();
	if (!read.ok) {
		return {
			heading: 'Conversation not found',
			subheading: 'It was archived, none of your agents are in it, or the link is wrong.',
			scope,
			shown: null,
			nowMs,
		};
	}
	const { conversation } = read.value;
	return {
		heading: thread ? `Thread in ${conversation.name}` : conversation.name,
		subheading: subheadingFor(conversation),
		scope,
		shown: { ...read.value, showsPins, thread, around },
		nowMs,
	};
};
