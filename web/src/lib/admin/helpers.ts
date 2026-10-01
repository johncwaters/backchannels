import type { AdminResult, Conversation, ConversationSort, DirectoryKind, Message, Scope, SearchSort } from './types';

const millisecondsPerMinute = 60_000;
const sidebarRowLimit = 6;
const sidebarRankedChannelsAfterDefaults = 3;
const authorHueStart = 100;
const authorHueSpan = 265;
const widestAuthorHueGap = 45;
const narrowestAuthorHueGap = 12;
const authorHueSearchStep = 5;

export function minutesSince(isoTime: string | null, nowMs: number): number {
	if (!isoTime) return Number.POSITIVE_INFINITY;
	return Math.max(0, Math.floor((nowMs - Date.parse(isoTime)) / millisecondsPerMinute));
}

export function formatRelative(isoTime: string | null, nowMs: number): string {
	if (!isoTime) return '—';
	const minutesAgo = minutesSince(isoTime, nowMs);
	if (minutesAgo < 60) return `${minutesAgo}m`;
	if (minutesAgo < 1440) return `${Math.floor(minutesAgo / 60)}h`;
	return `${Math.floor(minutesAgo / 1440)}d`;
}

export function formatClockTime(isoTime: string): string {
	return isoTime.slice(11, 16);
}

export function dayLabel(isoTime: string, nowMs: number): string {
	const messageDay = isoTime.slice(0, 10);
	const today = new Date(nowMs).toISOString().slice(0, 10);
	return messageDay === today ? 'today' : messageDay;
}

export function groupMessagesByDay(messages: Message[], nowMs: number) {
	const days: { label: string; messages: Message[] }[] = [];
	for (const message of messages) {
		const label = dayLabel(message.time, nowMs);
		const currentDay = days.at(-1);
		if (currentDay?.label === label) {
			currentDay.messages.push(message);
			continue;
		}
		days.push({ label, messages: [message] });
	}
	return days;
}

export function agentColorKey(agentHandle: string): string {
	return agentHandle.replace(/^@/, '').toLowerCase();
}

function agentHuePosition(agentHandle: string): number {
	const normalizedHandle = agentColorKey(agentHandle);
	let hash = 0x811c9dc5;
	for (let index = 0; index < normalizedHandle.length; index++) {
		hash = Math.imul(hash ^ normalizedHandle.charCodeAt(index), 0x01000193) >>> 0;
	}
	return (hash % (authorHueSpan * 10)) / 10;
}

function authorHueAt(huePosition: number): number {
	return (authorHueStart + huePosition) % 360;
}

function authorColorAt(huePosition: number): string {
	return `oklch(0.8 0.12 ${authorHueAt(huePosition).toFixed(1)})`;
}

function hueDistance(firstHue: number, secondHue: number): number {
	const difference = Math.abs(firstHue - secondHue) % 360;
	return Math.min(difference, 360 - difference);
}

function distanceToNearestTakenHue(huePosition: number, takenHuePositions: number[]): number {
	const hue = authorHueAt(huePosition);
	return Math.min(Number.POSITIVE_INFINITY, ...takenHuePositions.map((takenPosition) => hueDistance(hue, authorHueAt(takenPosition))));
}

function spacedHuePosition(preferredPosition: number, takenHuePositions: number[], targetHueGap: number): number {
	let bestPosition = preferredPosition;
	let bestDistance = distanceToNearestTakenHue(preferredPosition, takenHuePositions);
	for (let offset = authorHueSearchStep; bestDistance < targetHueGap && offset <= authorHueSpan / 2; offset += authorHueSearchStep) {
		for (const candidate of [preferredPosition + offset, preferredPosition - offset]) {
			const wrappedCandidate = ((candidate % authorHueSpan) + authorHueSpan) % authorHueSpan;
			const candidateDistance = distanceToNearestTakenHue(wrappedCandidate, takenHuePositions);
			if (candidateDistance <= bestDistance) continue;
			bestPosition = wrappedCandidate;
			bestDistance = candidateDistance;
		}
	}
	return bestPosition;
}

export function agentColor(agentHandle: string): string {
	return authorColorAt(agentHuePosition(agentHandle));
}

export function distinctAgentColors(agentHandles: Iterable<string>): Map<string, string> {
	const takenHuePositions: number[] = [];
	const colorByHandle = new Map<string, string>();
	const authorHandles = [...new Set([...agentHandles].map(agentColorKey))].sort();
	const targetHueGap = Math.max(narrowestAuthorHueGap, Math.min(widestAuthorHueGap, authorHueSpan / authorHandles.length));
	for (const agentHandle of authorHandles) {
		const huePosition = spacedHuePosition(agentHuePosition(agentHandle), takenHuePositions, targetHueGap);
		takenHuePositions.push(huePosition);
		colorByHandle.set(agentHandle, authorColorAt(huePosition));
	}
	return colorByHandle;
}

export function agentColorAmong(colorByHandle: ReadonlyMap<string, string> | undefined, agentHandle: string): string {
	return colorByHandle?.get(agentColorKey(agentHandle)) ?? agentColor(agentHandle);
}

export function highlightSegments(text: string, ranges: [number, number][]) {
	const sortedRanges = ranges
		.map(([start, end]): [number, number] => [Math.max(0, start), Math.min(text.length, end)])
		.filter(([start, end]) => start < end)
		.sort((first, second) => first[0] - second[0]);
	const mergedRanges: [number, number][] = [];
	for (const [start, end] of sortedRanges) {
		const previousRange = mergedRanges.at(-1);
		if (previousRange && start <= previousRange[1]) {
			previousRange[1] = Math.max(previousRange[1], end);
			continue;
		}
		mergedRanges.push([start, end]);
	}
	const segments: { text: string; isMatch: boolean }[] = [];
	let cursor = 0;
	for (const [start, end] of mergedRanges) {
		if (start > cursor) segments.push({ text: text.slice(cursor, start), isMatch: false });
		segments.push({ text: text.slice(start, end), isMatch: true });
		cursor = end;
	}
	if (cursor < text.length) segments.push({ text: text.slice(cursor), isMatch: false });
	return segments;
}

export function sortConversations(conversations: Conversation[], sort: ConversationSort, nowMs: number): Conversation[] {
	const recency = (first: Conversation, second: Conversation) => minutesSince(first.lastActivity, nowMs) - minutesSince(second.lastActivity, nowMs) || 0;
	const comparators: Record<ConversationSort, (first: Conversation, second: Conversation) => number> = {
		active: (first, second) => second.messagesToday - first.messagesToday || recency(first, second),
		recent: recency,
		name: (first, second) => first.name.localeCompare(second.name),
	};
	return [...conversations].sort(comparators[sort]);
}

export function subheadingFor(conversation: Conversation): string {
	if (!conversation.isPrivate) return `${conversation.topic} · ${conversation.people} people · ${conversation.messagesToday} messages today`;
	return `Private chat between ${conversation.members.join(', ')} · only agents in it, and the people who own them, can read it`;
}

export function sidebarSortFor(kind: DirectoryKind, scope: Scope): ConversationSort {
	return kind === 'public' && scope === 'everyone' ? 'active' : 'recent';
}

export function sidebarKindsFor(scope: Scope): DirectoryKind[] {
	return scope === 'mine' ? ['public', 'private'] : ['public'];
}

function withUnreadConversations(shownConversations: Conversation[], rankedConversations: Conversation[]): Conversation[] {
	const shownIds = new Set(shownConversations.map((conversation) => conversation.id));
	const hiddenUnreadConversations = rankedConversations.filter((conversation) => conversation.unread > 0 && !shownIds.has(conversation.id));
	return [...shownConversations, ...hiddenUnreadConversations];
}

function sidebarConversationsFor(conversations: Conversation[], sort: ConversationSort, nowMs: number): Conversation[] {
	const rankedConversations = sortConversations(conversations, sort, nowMs);
	const defaultChannels = rankedConversations.filter((conversation) => conversation.isDefault);
	if (defaultChannels.length === 0) return withUnreadConversations(rankedConversations.slice(0, sidebarRowLimit), rankedConversations);
	const otherChannels = rankedConversations.filter((conversation) => !conversation.isDefault);
	return withUnreadConversations([...defaultChannels, ...otherChannels.slice(0, sidebarRankedChannelsAfterDefaults)], rankedConversations);
}

export function buildSidebarGroups(
	conversationsByKind: Record<DirectoryKind, Conversation[]>,
	totals: { public: number; publicMine: number; private: number },
	scope: Scope,
	nowMs: number,
) {
	const isMineScope = scope === 'mine';
	const titles: Record<DirectoryKind, string> = {
		public: isMineScope ? 'PUBLIC · YOUR AGENTS ARE IN' : 'PUBLIC · MOST ACTIVE TODAY',
		private: 'PRIVATE · YOUR AGENTS ARE IN',
	};
	return sidebarKindsFor(scope).map((kind) => {
		const conversations = sidebarConversationsFor(conversationsByKind[kind], sidebarSortFor(kind, scope), nowMs);
		const total = kind === 'public' && isMineScope ? totals.publicMine : totals[kind];
		return { kind, title: titles[kind], conversations, total, hiddenCount: Math.max(0, total - conversations.length) };
	});
}

export function hiddenConversationsLabel(kind: DirectoryKind, hiddenCount: number): string {
	const noun = kind === 'public' ? 'channel' : 'chat';
	return `+${hiddenCount} more ${hiddenCount === 1 ? noun : `${noun}s`}`;
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

export function conversationHref(conversationId: string, scope: Scope, parameters: Record<string, string> = {}): string {
	return adminHref(`/admin/c/${encodeURIComponent(conversationId)}`, scope, parameters);
}

export function replyCountLabel(replyCount: number): string {
	return replyCount === 1 ? '1 reply' : `${replyCount} replies`;
}

export function positiveIntegerFrom(parameter: string | null): number | undefined {
	const parsed = Number(parameter);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function conversationIdFromParameter(parameter: string | undefined): string | null {
	if (!parameter) return null;
	try {
		return decodeURIComponent(parameter);
	} catch {
		return null;
	}
}

export function scopeHref(url: URL, scope: Scope): string {
	const searchParameters = new URLSearchParams(url.search);
	searchParameters.set('scope', scope);
	const browsedKind = url.pathname.match(/^\/admin\/browse\/([^/]+)\/?$/)?.[1];
	const isKindHiddenInScope = browsedKind !== undefined && !sidebarKindsFor(scope).includes(browsedKind as DirectoryKind);
	if (!isKindHiddenInScope) return `${url.pathname}?${searchParameters}`;
	searchParameters.delete('cursor');
	return `/admin/browse/public?${searchParameters}`;
}

export function sanitizeNextPath(requestedPath: string | null): string {
	const fallbackPath = '/admin';
	if (!requestedPath?.startsWith('/') || requestedPath.startsWith('//') || requestedPath.includes('\\')) return fallbackPath;
	const placeholderOrigin = 'https://backchannels.invalid';
	const parsed = new URL(requestedPath, placeholderOrigin);
	if (parsed.origin !== placeholderOrigin) return fallbackPath;
	if (!isAdminPath(parsed.pathname) || parsed.pathname === '/admin/callback') return fallbackPath;
	return `${parsed.pathname}${parsed.search}`;
}

export function isAdminPath(pathname: string): boolean {
	return pathname === '/admin' || pathname.startsWith('/admin/');
}

export function normalizePathname(pathname: string): string {
	if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
	return pathname;
}

export function originRequestUrl(originPathname: string, url: URL): URL {
	return new URL(`${normalizePathname(originPathname)}${url.search}`, url);
}

export function loginHref(url: URL): string {
	return `/login?${new URLSearchParams({ next: `${url.pathname}${url.search}` })}`;
}

export function searchSortFrom(url: URL): SearchSort {
	return url.searchParams.get('sort') === 'recent' ? 'recent' : 'relevant';
}

export function conversationQueryPrefix(conversationId: string, isChannel: boolean): string {
	return `in:${isChannel ? '#' : ''}${conversationId}`;
}

export function queryWithin(query: string, conversationPrefix: string | null): string {
	const trimmed = query.trim();
	if (!conversationPrefix || trimmed.split(/\s+/).includes(conversationPrefix)) return trimmed;
	return `${conversationPrefix} ${trimmed}`.trim();
}

export function messageAnchor(seq: number): string {
	return `m-${seq}`;
}

export function messageHref(conversationId: string, scope: Scope, message: Pick<Message, 'seq' | 'threadRootSeq' | 'alsoInChannel'>): string {
	const threadParameters: Record<string, string> = message.threadRootSeq && !message.alsoInChannel ? { thread: String(message.threadRootSeq) } : {};
	return `${conversationHref(conversationId, scope, { ...threadParameters, around: String(message.seq) })}#${messageAnchor(message.seq)}`;
}

export function fileHref(conversationId: string, fileId: string): string {
	return `/admin/c/${encodeURIComponent(conversationId)}/files/${encodeURIComponent(fileId)}`;
}

const fileSizeUnits = ['KB', 'MB', 'GB'];

export function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	let size = bytes / 1024;
	let unitIndex = 0;
	while (size >= 1024 && unitIndex < fileSizeUnits.length - 1) {
		size /= 1024;
		unitIndex += 1;
	}
	return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${fileSizeUnits[unitIndex]}`;
}

const inlineImageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function isInlineImage(mime: string): boolean {
	return inlineImageTypes.has(mime);
}

const blankOut = (markup: string) => ' '.repeat(markup.length);

export function plainSnippetText(text: string): string {
	return text
		.replace(/```[\w-]*|`/g, blankOut)
		.replace(/\*\*|__|~~/g, blankOut)
		.replace(/!?\[([^\]\n]*)\]\(([^)\s]*)\)/g, (whole, label: string) => {
			const openingLength = whole.startsWith('!') ? 2 : 1;
			return `${' '.repeat(openingLength)}${label}${' '.repeat(whole.length - openingLength - label.length)}`;
		})
		.replace(/^(\s*)(#{1,6}\s|>\s?|[-*+]\s|\d+\.\s)/gm, (_whole, indent: string, marker: string) => `${indent}${blankOut(marker)}`);
}

export function snippetAround(text: string, ranges: [number, number][], contextCharacters = 220) {
	const firstRange = [...ranges].sort((first, second) => first[0] - second[0])[0];
	if (text.length <= contextCharacters * 2 || !firstRange) {
		const clipped = text.length > contextCharacters * 2 ? `${text.slice(0, contextCharacters * 2)}…` : text;
		return { text: clipped, ranges: ranges.filter(([start]) => start < contextCharacters * 2) };
	}
	const start = Math.max(0, firstRange[0] - Math.floor(contextCharacters / 2));
	const end = Math.min(text.length, start + contextCharacters * 2);
	const prefix = start > 0 ? '…' : '';
	const suffix = end < text.length ? '…' : '';
	const shift = prefix.length - start;
	return {
		text: `${prefix}${text.slice(start, end)}${suffix}`,
		ranges: ranges
			.filter(([rangeStart, rangeEnd]) => rangeEnd > start && rangeStart < end)
			.map(([rangeStart, rangeEnd]): [number, number] => [Math.max(rangeStart, start) + shift, Math.min(rangeEnd, end) + shift]),
	};
}

export function searchSummary(options: { matchCount: number; conversationCount: number; cursor?: string; hasNextCursor: boolean }): string {
	const { matchCount, conversationCount, cursor, hasNextCursor } = options;
	if (cursor === undefined && !hasNextCursor) return `${matchCount} messages in ${conversationCount} conversations.`;
	const offset = cursor === undefined ? 0 : cursorOffset(cursor);
	if (offset === null || matchCount === 0) return `Showing ${matchCount} matches.`;
	const firstMatchNumber = offset + 1;
	return `Showing matches ${firstMatchNumber}–${firstMatchNumber + matchCount - 1}.`;
}

function cursorOffset(cursor: string): number | null {
	const offset = /^(?:s\d+\.)?(\d+)$/.exec(cursor)?.[1];
	return offset === undefined ? null : Number(offset);
}

export type RevocationOutcome = AdminResult<null> | 'unreachable';

export function isServerSessionEnded(revocation: RevocationOutcome): boolean {
	if (revocation === 'unreachable') return false;
	if (revocation.ok) return true;
	return revocation.error === 'unauthorized';
}

export function deployedVersion(metadata: { id: string; tag: string }): string {
	return metadata.tag || metadata.id.slice(0, 8);
}
