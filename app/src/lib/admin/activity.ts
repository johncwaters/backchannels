import type { ConversationPage, Message, SearchMatch } from './types';

export type ActivityView = 'all' | 'posts' | 'incoming';
export type ReplyCheck = 'found' | 'none' | 'unknown';

export interface ActivityEntry {
	match: SearchMatch;
	direction: 'post' | 'incoming';
	replyCheck?: ReplyCheck;
	reply?: SearchMatch;
}

export interface ReplyContext {
	conversation: string;
	thread?: number;
	after: number;
	entries: ActivityEntry[];
}

const maxReplyContexts = 8;
export const replyReadLimit = 100;

export function activityViewFrom(value: string | null): ActivityView {
	return value === 'posts' || value === 'incoming' ? value : 'all';
}

function threadFor(match: SearchMatch): number | undefined {
	return match.message.threadRootSeq ?? (match.conversation.name.startsWith('#') ? match.message.seq : undefined);
}

function isLaterOwnReply(incoming: SearchMatch, candidate: SearchMatch): boolean {
	if (!candidate.message.isOwn || candidate.message.deleted || candidate.conversation.id !== incoming.conversation.id || candidate.message.seq <= incoming.message.seq) return false;
	const thread = threadFor(incoming);
	return thread !== undefined ? candidate.message.threadRootSeq === thread : candidate.message.threadRootSeq === null || candidate.message.threadRootSeq === incoming.message.seq;
}

function firstOwnReply(incoming: SearchMatch, candidates: SearchMatch[]): SearchMatch | undefined {
	return candidates.filter((candidate) => isLaterOwnReply(incoming, candidate)).sort((left, right) => left.message.seq - right.message.seq)[0];
}

export function replyContexts(entries: ActivityEntry[]): ReplyContext[] {
	const grouped = new Map<string, ReplyContext>();
	for (const entry of entries) {
		if (entry.replyCheck === 'found') continue;
		const { conversation, message } = entry.match;
		const thread = threadFor(entry.match);
		const key = `${conversation.id}:${thread ?? 'chat'}`;
		const context = grouped.get(key);
		if (context) {
			context.after = Math.min(context.after, message.seq);
			context.entries.push(entry);
		} else {
			grouped.set(key, { conversation: conversation.id, thread, after: message.seq, entries: [entry] });
		}
	}
	return [...grouped.values()].slice(0, maxReplyContexts);
}

function matchesInConversation(messages: Message[], conversation: SearchMatch['conversation']): SearchMatch[] {
	return messages.map((message) => ({ message, conversation, ranges: [] }));
}

export function incomingEntriesFrom(incoming: SearchMatch[], ownPosts: SearchMatch[]): ActivityEntry[] {
	return incoming.filter((match) => !match.message.isOwn).map((match) => {
		const reply = firstOwnReply(match, ownPosts);
		return { match, direction: 'incoming', replyCheck: reply ? 'found' : 'unknown', reply };
	});
}

export function applyReplyRead(context: ReplyContext, read: Pick<ConversationPage, 'messages' | 'nextAfter'>): void {
	const candidates = matchesInConversation(read.messages, context.entries[0].match.conversation);
	for (const entry of context.entries) {
		entry.reply = firstOwnReply(entry.match, candidates);
		entry.replyCheck = entry.reply ? 'found' : read.nextAfter === undefined ? 'none' : 'unknown';
	}
}

export function entriesForView(view: ActivityView, ownPosts: SearchMatch[], incomingEntries: ActivityEntry[]): ActivityEntry[] {
	const postEntries: ActivityEntry[] = ownPosts.map((match) => ({ match, direction: 'post' }));
	const entries = view === 'posts' ? postEntries : view === 'incoming' ? incomingEntries : [...postEntries, ...incomingEntries];
	return entries.sort((left, right) => Date.parse(right.match.message.time) - Date.parse(left.match.message.time));
}
