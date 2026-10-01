import { WorkerEntrypoint } from 'cloudflare:workers';
import type {
	AdminApiRpc,
	AdminReadOptions,
	AdminResult,
	AdminSearchOptions,
	AdminSearchPage,
	AdminSession,
	Conversation,
	ConversationPage,
	ConversationSort,
	DirectoryKind,
	FileDownload,
	HeadlessKey,
	Message,
	NewHeadlessKey,
	ReadPosition,
	Scope,
	SearchMatch,
	Viewer,
} from '../../src/lib/admin/types';
import { DEFAULT_CHANNELS } from '../../../api/src/defaultChannels';
import { buildPreviewWorld, VIEWER_EMAIL, type PreviewWorld, type StoredConversation, type StoredMessage } from './preview-fixtures';

const DAY_MS = 24 * 60 * 60 * 1000;
const LIST_PAGE_SIZE = 100;
const SEARCH_PAGE_SIZE = 50;
const SEARCH_ID = 1;
const DEFAULT_READ_LIMIT = 100;
const MAX_READ_LIMIT = 200;
const TOP_FOR_RECENT = 3;
const ACCESS_TOKEN_PREFIX = 'preview-access-';
const REFRESH_TOKEN_PREFIX = 'preview-refresh-';

const invalid = { ok: false, error: 'invalid' } as const;
const notFound = { ok: false, error: 'not_found' } as const;
const unauthorized = { ok: false, error: 'unauthorized' } as const;
const ok = <Value>(value: Value) => ({ ok: true, value }) as const;

let world: PreviewWorld | null = null;
const previewWorld = () => (world ??= buildPreviewWorld(Date.now()));

const isOwnHandle = (handle: string) => handle.startsWith(`${VIEWER_EMAIL.split('@')[0]}/`);
const isoTime = (epochMs: number | null) => (epochMs === null ? null : new Date(epochMs).toISOString());
const agentName = (handle: string) => handle.slice(handle.indexOf('/') + 1);
const isPositiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const isOneOf = <Value extends string>(allowed: readonly Value[], value: unknown): value is Value => allowed.includes(value as Value);

function freshSession(): AdminSession {
	const suffix = crypto.randomUUID();
	return { accessToken: `${ACCESS_TOKEN_PREFIX}${suffix}`, refreshToken: `${REFRESH_TOKEN_PREFIX}${suffix}`, expiresAt: Date.now() + DAY_MS };
}

const isMine = (conversation: StoredConversation) => conversation.memberHandles.some(isOwnHandle);
const isVisible = (conversation: StoredConversation) => conversation.kind === 'public' || isMine(conversation);
const visibleConversations = () => previewWorld().conversations.filter(isVisible);
const findVisible = (slug: unknown) => visibleConversations().find((conversation) => conversation.slug === slug);

const displayName = (conversation: StoredConversation) =>
	conversation.kind === 'public' || conversation.kind === 'private' ? `#${conversation.slug}` : [...conversation.memberHandles].sort().join(', ');

const liveReplies = (conversation: StoredConversation, root: StoredMessage) =>
	conversation.messages.filter((message) => message.threadRootSeq === root.seq && message.deletedAt === null);

const PREVIEW_READ_UNTIL_AGO_MS = 3 * 60 * 60 * 1000;
const previewStartedAt = Date.now();
const channelReads = new Map<string, number>();
const threadReads = new Map<string, number>();
const isChannelStream = (message: StoredMessage) => message.threadRootSeq === null || message.alsoInChannel;
const isUnreadBy = (lastReadSeq: number) => (message: StoredMessage) =>
	message.seq > lastReadSeq && message.deletedAt === null && !isOwnHandle(message.author.handle);

function channelLastReadSeq(conversation: StoredConversation): number {
	const marker = channelReads.get(conversation.slug);
	if (marker !== undefined) return marker;
	const readUntil = previewStartedAt - PREVIEW_READ_UNTIL_AGO_MS;
	return conversation.messages.filter((message) => message.createdAt <= readUntil).at(-1)?.seq ?? 0;
}

function threadLastReadSeq(conversation: StoredConversation, rootSeq: number): number {
	return threadReads.get(`${conversation.slug}/${rootSeq}`) ?? channelLastReadSeq(conversation);
}

function unreadCount(conversation: StoredConversation): number {
	if (!isMine(conversation) && !channelReads.has(conversation.slug)) return 0;
	return conversation.messages.filter(isChannelStream).filter(isUnreadBy(channelLastReadSeq(conversation))).length;
}

const lastMessageAt = (conversation: StoredConversation) => conversation.messages.at(-1)?.createdAt ?? null;

function viewConversation(conversation: StoredConversation): Conversation {
	const now = Date.now();
	const live = conversation.messages.filter((message) => message.deletedAt === null);
	const latest = live.at(-1);
	const topic = conversation.kind === 'dm' || conversation.kind === 'group' ? '' : conversation.topic;
	const lastAt = lastMessageAt(conversation);
	return {
		id: conversation.slug,
		name: displayName(conversation),
		kind: conversation.kind,
		isPrivate: conversation.kind !== 'public',
		isDefault: conversation.kind === 'public' && DEFAULT_CHANNELS.some((channel) => channel.name === conversation.slug),
		topic,
		members: conversation.kind === 'public' ? [] : [...conversation.memberHandles].sort(),
		people: new Set(conversation.memberHandles.map((handle) => handle.split('/')[0])).size,
		messagesToday: live.filter((message) => message.createdAt > now - DAY_MS).length,
		lastActivity: isoTime(lastAt),
		isMine: isMine(conversation),
		pins: live.filter((message) => message.pinned).length,
		unread: unreadCount(conversation),
		lastReadSeq: channelLastReadSeq(conversation),
		preview: latest ? `${latest.author.handle}: ${latest.text}` : topic,
	};
}

function viewMessage(conversation: StoredConversation, message: StoredMessage): Message {
	const replies = message.threadRootSeq === null ? liveReplies(conversation, message) : [];
	const isDeleted = message.deletedAt !== null;
	return {
		seq: message.seq,
		person: message.author.email.split('@')[0],
		personEmail: message.author.email,
		agent: agentName(message.author.handle),
		handle: message.author.handle,
		time: new Date(message.createdAt).toISOString(),
		text: isDeleted ? '' : message.text,
		isOwn: isOwnHandle(message.author.handle),
		threadReplies: replies.length,
		lastReplyAt: isoTime(replies.at(-1)?.createdAt ?? null),
		threadRootSeq: message.threadRootSeq,
		alsoInChannel: message.alsoInChannel,
		editedAt: isoTime(message.editedAt),
		deleted: isDeleted,
		pinned: message.pinned ? { by: message.pinned.by, at: new Date(message.pinned.at).toISOString() } : null,
		unreadReplies: message.threadRootSeq === null ? replies.filter(isUnreadBy(threadLastReadSeq(conversation, message.seq))).length : 0,
		reactions: isDeleted ? [] : message.reactions.map((reaction) => ({ emoji: reaction.emoji, agents: [...reaction.agents] })),
		files: isDeleted ? [] : message.files.map((file) => ({ ...file })),
	};
}

const SORTS: readonly ConversationSort[] = ['active', 'recent', 'name'];
const SCOPES: readonly Scope[] = ['mine', 'everyone'];
const KINDS: readonly DirectoryKind[] = ['public', 'private'];

function compareConversations(sort: ConversationSort) {
	const byRecent = (left: Conversation, right: Conversation) => (right.lastActivity ?? '').localeCompare(left.lastActivity ?? '');
	if (sort === 'name') return (left: Conversation, right: Conversation) => left.name.toLowerCase().localeCompare(right.name.toLowerCase());
	if (sort === 'recent') return byRecent;
	return (left: Conversation, right: Conversation) => right.messagesToday - left.messagesToday || byRecent(left, right);
}

type StreamPage = { rows: StoredMessage[]; hasOlder: boolean; hasNewer: boolean };

function readStream(stream: StoredMessage[], position: ReadPosition, limit: number): StreamPage {
	const olderThan = (pivot: number, count: number) => stream.filter((message) => message.seq < pivot).reverse().slice(0, count);
	const newerThan = (pivot: number, count: number) => stream.filter((message) => message.seq > pivot).slice(0, count);
	const atOrNewer = (pivot: number, count: number) => stream.filter((message) => message.seq >= pivot).slice(0, count);

	if (position.after !== undefined) {
		const newer = newerThan(position.after, limit + 1);
		return { rows: newer.slice(0, limit), hasOlder: true, hasNewer: newer.length > limit };
	}
	if (position.around !== undefined) {
		const olderCount = Math.floor(limit / 2);
		const older = olderThan(position.around, olderCount + 1);
		const newer = atOrNewer(position.around, limit - olderCount + 1);
		return {
			rows: [...older.slice(0, olderCount).reverse(), ...newer.slice(0, limit - olderCount)],
			hasOlder: older.length > olderCount,
			hasNewer: newer.length > limit - olderCount,
		};
	}
	const older = olderThan(position.before ?? Number.MAX_SAFE_INTEGER, limit + 1);
	const page = older.slice(0, limit).reverse();
	const hasNewer = position.before !== undefined && page.length > 0 && newerThan(page.at(-1)!.seq, 1).length > 0;
	return { rows: page, hasOlder: older.length > limit, hasNewer };
}

function readConversation(options: AdminReadOptions): AdminResult<ConversationPage> {
	const positions = [options?.before, options?.after, options?.around].filter((value) => value !== undefined);
	if (typeof options?.conversation !== 'string' || positions.length > 1) return invalid;
	if (options.thread !== undefined && !isPositiveInteger(options.thread)) return invalid;
	if (!positions.every(isPositiveInteger)) return invalid;
	if (options.limit !== undefined && !isPositiveInteger(options.limit)) return invalid;
	const limit = Math.min(options.limit ?? DEFAULT_READ_LIMIT, MAX_READ_LIMIT);

	const conversation = findVisible(options.conversation);
	if (!conversation) return notFound;
	const isStreamable = (message: StoredMessage) => message.deletedAt === null || liveReplies(conversation, message).length > 0;
	const threadRoot =
		options.thread === undefined
			? null
			: conversation.messages.find((message) => message.seq === options.thread && message.threadRootSeq === null && isStreamable(message));
	if (options.thread !== undefined && !threadRoot) return notFound;
	const inScope = threadRoot
		? (message: StoredMessage) => message.seq === threadRoot.seq || message.threadRootSeq === threadRoot.seq
		: (message: StoredMessage) => message.threadRootSeq === null || message.alsoInChannel;
	const stream = conversation.messages.filter((message) => inScope(message) && isStreamable(message));
	const lastReadSeq = threadRoot ? threadLastReadSeq(conversation, threadRoot.seq) : channelLastReadSeq(conversation);
	const firstUnreadSeq = conversation.messages.filter(inScope).find(isUnreadBy(lastReadSeq))?.seq;
	const opensAtFirstUnread = positions.length === 0 && firstUnreadSeq !== undefined && stream.filter((message) => message.seq >= firstUnreadSeq).length > limit;
	const { rows, hasOlder, hasNewer } = readStream(stream, opensAtFirstUnread ? { around: firstUnreadSeq } : options, limit);
	return ok({
		conversation: viewConversation(conversation),
		messages: rows.map((message) => viewMessage(conversation, message)),
		lastReadSeq,
		...(firstUnreadSeq !== undefined ? { firstUnreadSeq } : {}),
		...(hasOlder && rows.length ? { nextBefore: rows[0].seq } : {}),
		...(hasNewer && rows.length ? { nextAfter: rows.at(-1)!.seq } : {}),
	});
}

interface ParsedQuery {
	words: string[];
	inChannel: string | null;
	fromAgent: string | null;
}

function parseQuery(query: string): ParsedQuery {
	const parsed: ParsedQuery = { words: [], inChannel: null, fromAgent: null };
	for (const token of query.matchAll(/(\w+):("[^"]*"|\S+)|"([^"]*)"|(\S+)/g)) {
		const [, modifier, modifierValue, phrase, word] = token;
		if (modifier === 'in') parsed.inChannel = modifierValue.replace(/^#/, '').toLowerCase();
		else if (modifier === 'from') parsed.fromAgent = modifierValue.replace(/^@/, '').toLowerCase();
		else if (phrase !== undefined && phrase.trim()) parsed.words.push(phrase.trim().toLowerCase());
		else if (word !== undefined) parsed.words.push(word.toLowerCase());
	}
	return parsed;
}

function editDistance(left: string, right: string): number {
	const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let row = 1; row <= left.length; row += 1) {
		let diagonal = previous[0];
		previous[0] = row;
		for (let column = 1; column <= right.length; column += 1) {
			const above = previous[column];
			previous[column] = Math.min(above + 1, previous[column - 1] + 1, diagonal + (left[row - 1] === right[column - 1] ? 0 : 1));
			diagonal = above;
		}
	}
	return previous[right.length];
}

function matchRanges(text: string, words: string[]): [number, number][] {
	const lowered = text.toLowerCase();
	const ranges: [number, number][] = [];
	for (const word of words) {
		for (let start = lowered.indexOf(word); start !== -1; start = lowered.indexOf(word, start + word.length)) {
			ranges.push([start, start + word.length]);
		}
	}
	ranges.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
	return ranges.reduce<[number, number][]>((merged, range) => {
		const last = merged.at(-1);
		if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
		else merged.push([range[0], range[1]]);
		return merged;
	}, []);
}

function search(options: AdminSearchOptions): AdminResult<AdminSearchPage> {
	const sort = options?.sort ?? 'relevant';
	if (typeof options?.query !== 'string' || !isOneOf(SCOPES, options.scope) || !isOneOf(['relevant', 'recent'], sort)) return invalid;
	const offset = options.cursor === undefined ? 0 : Number(/^s\d+\.(\d{1,9})$/.exec(options.cursor)?.[1] ?? NaN);
	if (!Number.isSafeInteger(offset)) return invalid;

	const parsed = parseQuery(options.query);
	const searchable = visibleConversations().filter((conversation) => options.scope === 'everyone' || isMine(conversation));
	let conversations = searchable;
	if (parsed.inChannel !== null) {
		const channel = searchable.find((conversation) => conversation.slug === parsed.inChannel);
		if (!channel) {
			const channels = searchable.filter((conversation) => conversation.kind === 'public' || conversation.kind === 'private');
			const closest = channels.reduce((best, candidate) =>
				editDistance(candidate.slug, parsed.inChannel!) < editDistance(best.slug, parsed.inChannel!) ? candidate : best,
			);
			return ok({ matches: [], problem: `channel #${parsed.inChannel} not found; did you mean #${closest.slug}?` });
		}
		conversations = [channel];
	}
	if (parsed.words.length === 0 && parsed.fromAgent === null) return ok({ matches: [], problem: 'Type at least one word to search for.' });

	const found: { match: SearchMatch; score: number; time: number }[] = [];
	for (const conversation of conversations) {
		for (const message of conversation.messages) {
			if (message.deletedAt !== null) continue;
			if (parsed.fromAgent !== null && !message.author.handle.toLowerCase().includes(parsed.fromAgent)) continue;
			const lowered = message.text.toLowerCase();
			if (!parsed.words.every((word) => lowered.includes(word))) continue;
			const ranges = matchRanges(message.text, parsed.words);
			found.push({
				match: {
					conversation: { id: conversation.slug, name: displayName(conversation), isPrivate: conversation.kind !== 'public' },
					message: viewMessage(conversation, message),
					ranges,
				},
				score: ranges.length,
				time: message.createdAt,
			});
		}
	}
	const byRecent = [...found].sort((left, right) => right.time - left.time);
	const byRelevance = [...found].sort((left, right) => right.score - left.score || right.time - left.time);
	const ordered = (sort === 'recent' ? byRecent : byRelevance).map((entry) => entry.match);
	const nextOffset = offset + SEARCH_PAGE_SIZE;
	const top = sort === 'recent' && offset === 0 && found.length > TOP_FOR_RECENT ? byRelevance.slice(0, TOP_FOR_RECENT).map((entry) => entry.match) : undefined;
	return ok({
		matches: ordered.slice(offset, nextOffset),
		...(top ? { top } : {}),
		...(nextOffset < ordered.length ? { nextCursor: `s${SEARCH_ID}.${nextOffset}` } : {}),
	});
}

function newKey(label: string, suggestedName: string, expiresInDays: number, rotatedFrom: string | null): NewHeadlessKey {
	const now = Date.now();
	const secret = `bck_${crypto.randomUUID().replaceAll('-', '')}`;
	const key: HeadlessKey = {
		id: `key-${crypto.randomUUID().slice(0, 8)}`,
		label,
		suggestedName,
		keyHint: secret.slice(-4),
		sponsorEmail: VIEWER_EMAIL,
		createdAt: new Date(now).toISOString(),
		expiresAt: new Date(now + expiresInDays * DAY_MS).toISOString(),
		lastUsedAt: null,
		rotatedFrom,
		hasSuccessor: false,
	};
	previewWorld().headlessKeys.unshift(key);
	return { keyId: key.id, key: secret, label };
}

function simulatedLatency(environment: unknown): Promise<void> {
	const latencyMs = Number((environment as { PREVIEW_LATENCY_MS?: string }).PREVIEW_LATENCY_MS ?? 0);
	return latencyMs > 0 ? new Promise((resolve) => setTimeout(resolve, latencyMs)) : Promise.resolve();
}

export class AdminApi extends WorkerEntrypoint implements AdminApiRpc {
	async adminSignInUrl(input: { redirectUri: string; state: string; codeChallenge: string }): Promise<AdminResult<string>> {
		const url = new URL(input.redirectUri);
		url.searchParams.set('code', 'preview');
		url.searchParams.set('state', input.state);
		return ok(url.href);
	}

	async exchangeAdminCode(): Promise<AdminResult<AdminSession>> {
		return ok(freshSession());
	}

	async refreshAdminSession(input: { refreshToken: string }): Promise<AdminResult<AdminSession>> {
		if (!input.refreshToken.startsWith(REFRESH_TOKEN_PREFIX)) return unauthorized;
		return ok(freshSession());
	}

	async revokeAdminSession(): Promise<AdminResult<null>> {
		return ok(null);
	}

	async viewer(token: string): Promise<AdminResult<Viewer>> {
		if (!isPreviewToken(token)) return unauthorized;
		await simulatedLatency(this.env);
		return ok({ email: VIEWER_EMAIL, name: 'Ian Matson', workspaceName: 'posthog', isAdmin: true });
	}

	async serverVersion(token: string): Promise<AdminResult<string>> {
		if (!isPreviewToken(token)) return unauthorized;
		return ok('preview');
	}

	async changeToken(token: string): Promise<AdminResult<string>> {
		if (!isPreviewToken(token)) return unauthorized;
		return ok('preview:0');
	}

	async listConversations(
		token: string,
		options: { scope: Scope; kind?: DirectoryKind; sort?: ConversationSort; filter?: string; cursor?: string },
	): ReturnType<AdminApiRpc['listConversations']> {
		if (!isPreviewToken(token)) return unauthorized;
		const sort = options?.sort ?? 'active';
		const offset = options?.cursor === undefined ? 0 : /^\d{1,9}$/.test(options.cursor) ? Number(options.cursor) : null;
		if (!isOneOf(SCOPES, options?.scope) || !isOneOf(SORTS, sort) || offset === null) return invalid;
		if (options.kind !== undefined && !isOneOf(KINDS, options.kind)) return invalid;
		const filter = options.filter?.trim().toLowerCase() ?? '';
		const listed = visibleConversations()
			.filter((conversation) => options.scope === 'everyone' || isMine(conversation))
			.filter((conversation) => options.kind === undefined || (options.kind === 'public') === (conversation.kind === 'public'))
			.map(viewConversation)
			.filter((conversation) => !filter || `${conversation.name} ${conversation.topic}`.toLowerCase().includes(filter))
			.sort(compareConversations(sort));
		const all = previewWorld().conversations;
		return ok({
			conversations: listed.slice(offset, offset + LIST_PAGE_SIZE),
			totals: {
				public: all.filter((conversation) => conversation.kind === 'public').length,
				publicMine: all.filter((conversation) => conversation.kind === 'public' && isMine(conversation)).length,
				private: all.filter((conversation) => conversation.kind !== 'public' && isMine(conversation)).length,
			},
			...(listed.length > offset + LIST_PAGE_SIZE ? { nextCursor: String(offset + LIST_PAGE_SIZE) } : {}),
		});
	}

	async readConversation(token: string, options: AdminReadOptions): Promise<AdminResult<ConversationPage>> {
		if (!isPreviewToken(token)) return unauthorized;
		return readConversation(options);
	}

	async markRead(token: string, options: { conversation: string; thread?: number; upToSeq: number }): ReturnType<AdminApiRpc['markRead']> {
		if (!isPreviewToken(token)) return unauthorized;
		if (!isPositiveInteger(options?.upToSeq)) return invalid;
		const conversation = findVisible(options.conversation);
		if (!conversation) return notFound;
		const upToSeq = Math.min(options.upToSeq, conversation.messages.at(-1)?.seq ?? 0);
		if (options.thread === undefined) channelReads.set(conversation.slug, Math.max(channelLastReadSeq(conversation), upToSeq));
		else {
			const threadKey = `${conversation.slug}/${options.thread}`;
			threadReads.set(threadKey, Math.max(threadLastReadSeq(conversation, options.thread), upToSeq));
		}
		return ok({ unread: unreadCount(conversation) });
	}

	async listPins(token: string, options: { conversation: string }): ReturnType<AdminApiRpc['listPins']> {
		if (!isPreviewToken(token)) return unauthorized;
		const conversation = findVisible(options?.conversation);
		if (!conversation) return notFound;
		const pinned = conversation.messages
			.filter((message) => message.pinned && message.deletedAt === null)
			.sort((left, right) => right.pinned!.at - left.pinned!.at)
			.slice(0, MAX_READ_LIMIT);
		return ok({ conversation: viewConversation(conversation), messages: pinned.map((message) => viewMessage(conversation, message)) });
	}

	async downloadFile(token: string, options: { conversation: string; file: string }): Promise<AdminResult<FileDownload>> {
		if (!isPreviewToken(token)) return unauthorized;
		const conversation = findVisible(options?.conversation);
		const file = previewWorld().files.get(options?.file);
		if (!conversation || !file || file.conversation !== conversation.slug) return notFound;
		const owner = conversation.messages.find((message) => message.files.some((attached) => attached.id === options.file));
		if (!owner || owner.deletedAt !== null) return notFound;
		return ok({ name: file.name, mime: file.mime, body: file.body.slice().buffer });
	}

	async search(token: string, options: AdminSearchOptions): Promise<AdminResult<AdminSearchPage>> {
		if (!isPreviewToken(token)) return unauthorized;
		return search(options);
	}

	async listInstallations(token: string): ReturnType<AdminApiRpc['listInstallations']> {
		if (!isPreviewToken(token)) return unauthorized;
		return ok({ installations: previewWorld().installations });
	}

	async revokeInstallation(token: string, options: { grantId: string }): Promise<AdminResult<null>> {
		if (!isPreviewToken(token)) return unauthorized;
		const installations = previewWorld().installations;
		const index = installations.findIndex((installation) => installation.grantId === options?.grantId);
		if (index === -1) return notFound;
		installations.splice(index, 1);
		return ok(null);
	}

	async listHeadlessKeys(token: string): ReturnType<AdminApiRpc['listHeadlessKeys']> {
		if (!isPreviewToken(token)) return unauthorized;
		return ok({ keys: previewWorld().headlessKeys, agents: previewWorld().headlessAgents });
	}

	async createHeadlessKey(token: string, options: { label: string; suggestedName: string; expiresInDays: number }): Promise<AdminResult<NewHeadlessKey>> {
		if (!isPreviewToken(token)) return unauthorized;
		if (!options?.label?.trim() || !options.suggestedName?.trim() || !isPositiveInteger(options.expiresInDays)) return invalid;
		return ok(newKey(options.label.trim(), options.suggestedName.trim(), options.expiresInDays, null));
	}

	async rotateHeadlessKey(token: string, options: { keyId: string }): Promise<AdminResult<NewHeadlessKey>> {
		if (!isPreviewToken(token)) return unauthorized;
		const existing = previewWorld().headlessKeys.find((key) => key.id === options?.keyId);
		if (!existing) return notFound;
		if (existing.hasSuccessor) return { ok: false, error: 'already_rotated' };
		existing.hasSuccessor = true;
		const remainingDays = Math.max(1, Math.round((Date.parse(existing.expiresAt) - Date.now()) / DAY_MS));
		return ok(newKey(existing.label, existing.suggestedName, remainingDays, existing.id));
	}

	async revokeHeadlessKey(token: string, options: { keyId: string }): Promise<AdminResult<null>> {
		if (!isPreviewToken(token)) return unauthorized;
		const keys = previewWorld().headlessKeys;
		const index = keys.findIndex((key) => key.id === options?.keyId);
		if (index === -1) return notFound;
		keys.splice(index, 1);
		return ok(null);
	}

	async revokeHeadlessAgent(token: string, options: { handle: string }): Promise<AdminResult<null>> {
		if (!isPreviewToken(token)) return unauthorized;
		const agents = previewWorld().headlessAgents;
		const index = agents.findIndex((agent) => agent.handle === options?.handle);
		if (index === -1) return notFound;
		agents.splice(index, 1);
		return ok(null);
	}

	async listOwnAgents(token: string): ReturnType<AdminApiRpc['listOwnAgents']> {
		if (!isPreviewToken(token)) return unauthorized;
		return ok({ agents: previewWorld().ownAgents });
	}

	async revokeOwnAgent(token: string, options: { handle: string }): Promise<AdminResult<null>> {
		if (!isPreviewToken(token)) return unauthorized;
		if (typeof options?.handle !== 'string' || !options.handle) return invalid;
		const agents = previewWorld().ownAgents;
		const index = agents.findIndex((agent) => agent.handle === options.handle.replace(/^@/, ''));
		if (index === -1) return notFound;
		agents.splice(index, 1);
		return ok(null);
	}
}

function isPreviewToken(token: unknown): boolean {
	return typeof token === 'string' && token.startsWith(ACCESS_TOKEN_PREFIX);
}

export default {
	async fetch(): Promise<Response> {
		return new Response('Not found', { status: 404 });
	},
};
