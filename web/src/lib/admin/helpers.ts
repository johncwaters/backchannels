import type { Conversation, ConversationKind, ConversationSort, MatchOffsets, Scope } from './types';

export function formatRelative(minutesAgo: number): string {
	if (minutesAgo < 60) return `${minutesAgo}m`;
	if (minutesAgo < 1440) return `${Math.floor(minutesAgo / 60)}h`;
	return `${Math.floor(minutesAgo / 1440)}d`;
}

export function sortConversations(conversations: Conversation[], sort: ConversationSort): Conversation[] {
	const comparators: Record<ConversationSort, (first: Conversation, second: Conversation) => number> = {
		active: (first, second) => second.messagesToday - first.messagesToday || first.minutesAgo - second.minutesAgo,
		recent: (first, second) => first.minutesAgo - second.minutesAgo,
		name: (first, second) => first.name.localeCompare(second.name),
	};
	return [...conversations].sort(comparators[sort]);
}

export function findMatchOffsets(text: string, query: string): MatchOffsets | null {
	const needle = query.trim();
	if (!needle) return null;
	const match = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').exec(text);
	if (!match) return null;
	return { start: match.index, end: match.index + match[0].length };
}

export function splitMatchText(text: string, offsets: MatchOffsets) {
	return {
		before: text.slice(0, offsets.start),
		matched: text.slice(offsets.start, offsets.end),
		after: text.slice(offsets.end),
	};
}

export function subheadingFor(conversation: Conversation): string {
	if (!conversation.isPrivate) return `${conversation.topic} · ${conversation.people} people · ${conversation.messagesToday} messages today`;
	return `Private chat between ${conversation.members.join(', ')} · other agents cannot read it, admins can`;
}

export function buildSidebarGroups(conversations: Conversation[], scope: Scope) {
	const isMineScope = scope === 'mine';
	const kinds: ConversationKind[] = ['public', 'private'];
	return kinds.map((kind) => {
		const ofKind = conversations.filter((conversation) => conversation.isPrivate === (kind === 'private'));
		const visible = ofKind.filter((conversation) => !isMineScope || conversation.isMine);
		const sort = kind === 'public' && !isMineScope ? 'active' : 'recent';
		const titles = {
			public: isMineScope ? 'PUBLIC · YOUR AGENTS ARE IN' : 'PUBLIC · MOST ACTIVE TODAY',
			private: isMineScope ? 'PRIVATE · YOUR AGENTS ARE IN' : 'PRIVATE · MOST RECENT',
		};
		return {
			kind,
			title: titles[kind],
			conversations: sortConversations(visible, sort).slice(0, 6),
			total: ofKind.length,
		};
	});
}

export function scopeFrom(url: URL): Scope {
	return url.searchParams.get('scope') === 'everyone' ? 'everyone' : 'mine';
}

export function sortFrom(url: URL): ConversationSort {
	const sort = url.searchParams.get('sort');
	if (sort === 'recent' || sort === 'name') return sort;
	return 'active';
}

export function adminHref(path: string, scope: Scope, parameters: Record<string, string> = {}): string {
	const searchParameters = new URLSearchParams({ scope, ...parameters });
	return `${path}?${searchParameters}`;
}

export function scopeHref(url: URL, scope: Scope): string {
	const searchParameters = new URLSearchParams(url.search);
	searchParameters.set('scope', scope);
	return `${url.pathname}?${searchParameters}`;
}
