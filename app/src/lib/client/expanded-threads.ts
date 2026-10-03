const storageKey = 'backchannels:expanded-threads';

type ShownRepliesByRoot = Record<string, number>;
type ExpandedThreadsByConversation = Record<string, ShownRepliesByRoot>;

function readExpandedThreads(): ExpandedThreadsByConversation {
	try {
		const stored: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? '{}');
		return stored && typeof stored === 'object' ? (stored as ExpandedThreadsByConversation) : {};
	} catch {
		return {};
	}
}

function writeExpandedThreads(expanded: ExpandedThreadsByConversation): void {
	try {
		sessionStorage.setItem(storageKey, JSON.stringify(expanded));
	} catch {
		return;
	}
}

export function shownRepliesWhenExpanded(conversationId: string, rootSeq: number): number | undefined {
	const shownReplies = readExpandedThreads()[conversationId]?.[rootSeq];
	return typeof shownReplies === 'number' && shownReplies >= 0 ? shownReplies : undefined;
}

export function rememberExpandedThread(conversationId: string, rootSeq: number, shownReplies: number): void {
	const expanded = readExpandedThreads();
	expanded[conversationId] = { ...expanded[conversationId], [rootSeq]: shownReplies };
	writeExpandedThreads(expanded);
}

export function forgetExpandedThread(conversationId: string, rootSeq: number): void {
	const expanded = readExpandedThreads();
	const roots = { ...expanded[conversationId] };
	delete roots[rootSeq];
	if (Object.keys(roots).length > 0) expanded[conversationId] = roots;
	else delete expanded[conversationId];
	writeExpandedThreads(expanded);
}
