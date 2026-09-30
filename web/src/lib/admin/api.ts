import { findMatchOffsets, sortConversations } from './helpers';
import { buildSampleConversations, type ConversationWithMessages } from './sample';
import type { AdminApi, Conversation, ListOptions, ReadOptions, SearchOptions } from './types';

function summarizeConversation(conversation: ConversationWithMessages): Conversation {
	const { messages, ...summary } = conversation;
	return summary;
}

function paginate<Item>(items: Item[], cursor?: string) {
	const requestedOffset = Number(cursor ?? 0);
	const offset = Number.isSafeInteger(requestedOffset) && requestedOffset >= 0 ? requestedOffset : 0;
	const pageSize = 100;
	return {
		items: items.slice(offset, offset + pageSize),
		nextCursor: offset + pageSize < items.length ? String(offset + pageSize) : undefined,
	};
}

export class FakeAdminApi implements AdminApi {
	private readonly conversations = buildSampleConversations();

	async listConversations(token: string, options: ListOptions) {
		const needle = options.filter?.trim().toLowerCase() ?? '';
		const matching = this.conversations.filter((conversation) => {
			if (options.scope === 'mine' && !conversation.isMine) return false;
			if (options.kind && conversation.isPrivate !== (options.kind === 'private')) return false;
			return `${conversation.name} ${conversation.topic}`.toLowerCase().includes(needle);
		});
		const page = paginate(sortConversations(matching.map(summarizeConversation), options.sort ?? 'active'), options.cursor);
		return { conversations: page.items, nextCursor: page.nextCursor };
	}

	async readConversation(token: string, options: ReadOptions) {
		const conversation = this.conversations.find((conversation) => conversation.id === options.conversation);
		if (!conversation) return null;
		const before = options.before;
		const messagesBefore = conversation.messages.filter((message) => !before || message.time < before);
		const requestedLimit = options.limit ?? 100;
		const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? requestedLimit : 100;
		const messages = messagesBefore.slice(-limit);
		return {
			conversation: summarizeConversation(conversation),
			messages,
			nextBefore: messagesBefore.length > messages.length ? messages[0].time : undefined,
		};
	}

	async search(token: string, options: SearchOptions) {
		const visible = this.conversations.filter((conversation) => options.scope === 'everyone' || conversation.isMine);
		const matches = visible.flatMap((conversation) => conversation.messages.flatMap((message) => {
			const offsets = findMatchOffsets(message.text, options.query);
			if (!offsets) return [];
			return [{ conversation: summarizeConversation(conversation), message, ...offsets }];
		}));
		const page = paginate(matches, options.cursor);
		return { matches: page.items, nextCursor: page.nextCursor };
	}
}

export function adminApiFor(locals: unknown): AdminApi {
	return new FakeAdminApi();
}
