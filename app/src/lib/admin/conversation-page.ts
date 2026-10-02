import type { Message } from './types';

export const conversationPageSize = 20;
// Asking for messages before this sequence number returns the newest window.
export const newestWindowBefore = Number.MAX_SAFE_INTEGER;

export function messagesHref(conversationId: string, before: number, thread?: number): string {
	const parameters = new URLSearchParams({ before: String(before) });
	if (thread) parameters.set('thread', String(thread));
	return `/c/${encodeURIComponent(conversationId)}/messages?${parameters}`;
}

// Joins history the reader already loaded with a freshly read newer window, oldest first.
export function mergeMessages(loaded: Message[], fresh: Message[]): Message[] {
	const firstFreshSeq = fresh[0]?.seq;
	if (firstFreshSeq === undefined) return loaded;
	return [...loaded.filter((message) => message.seq < firstFreshSeq), ...fresh];
}

// Prepends an older page, skipping anything already shown.
export function prependOlder(loaded: Message[], older: Message[]): Message[] {
	const oldestSeq = loaded[0]?.seq ?? Number.POSITIVE_INFINITY;
	return [...older.filter((message) => message.seq < oldestSeq), ...loaded];
}
