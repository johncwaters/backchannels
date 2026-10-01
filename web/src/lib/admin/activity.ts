import type { AdminApi } from './api';
import type { AdminResult, AdminSearchPage, Message, SearchMatch } from './types';

export type ActivityView = 'all' | 'posts' | 'incoming';
export type ReplyCheck = 'found' | 'none' | 'unknown';

export interface ActivityEntry {
	match: SearchMatch;
	direction: 'post' | 'incoming';
	replyCheck?: ReplyCheck;
	reply?: SearchMatch;
}

export interface ActivityPage {
	entries: ActivityEntry[];
	posts: AdminSearchPage;
	incoming?: AdminSearchPage;
}

interface ReplyContext {
	conversation: string;
	thread?: number;
	after: number;
	entries: ActivityEntry[];
}

const maxReplyContexts = 8;
const replyReadLimit = 100;

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

function replyContexts(entries: ActivityEntry[]): ReplyContext[] {
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

export async function loadActivity(adminApi: AdminApi, view: ActivityView, cursor?: string): Promise<AdminResult<ActivityPage>> {
	const [posts, incoming] = await Promise.all([
		adminApi.search({ query: 'from:me', scope: 'everyone', sort: 'recent', ...(view === 'posts' && cursor ? { cursor } : {}) }),
		view === 'posts' ? undefined : adminApi.search({ query: 'to:me', scope: 'everyone', sort: 'recent', ...(view === 'incoming' && cursor ? { cursor } : {}) }),
	]);
	if (!posts.ok) return posts;
	if (incoming && !incoming.ok) return incoming;
	const ownPosts = posts.value.matches.filter((match) => match.message.isOwn);
	const incomingEntries: ActivityEntry[] = incoming?.value.matches.filter((match) => !match.message.isOwn).map((match) => {
		const reply = firstOwnReply(match, ownPosts);
		return { match, direction: 'incoming', replyCheck: reply ? 'found' : 'unknown', reply };
	}) ?? [];
	const checks = await Promise.all(replyContexts(incomingEntries).map(async (context) => {
		const result = await adminApi.readConversation({ conversation: context.conversation, thread: context.thread, after: context.after, limit: replyReadLimit }).catch(() => null);
		return { context, result };
	}));
	for (const { context, result } of checks) {
		if (result && !result.ok && result.error === 'unauthorized') return result;
		if (!result?.ok) continue;
		const candidates = matchesInConversation(result.value.messages, context.entries[0].match.conversation);
		for (const entry of context.entries) {
			entry.reply = firstOwnReply(entry.match, candidates);
			entry.replyCheck = entry.reply ? 'found' : result.value.nextAfter === undefined ? 'none' : 'unknown';
		}
	}
	const postEntries: ActivityEntry[] = ownPosts.map((match) => ({ match, direction: 'post' }));
	const entries = (view === 'posts' ? postEntries : view === 'incoming' ? incomingEntries : [...postEntries, ...incomingEntries]).sort((left, right) => Date.parse(right.match.message.time) - Date.parse(left.match.message.time));
	return { ok: true, value: { entries, posts: posts.value, incoming: incoming?.value } };
}
