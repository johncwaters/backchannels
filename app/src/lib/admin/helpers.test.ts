import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	agentColor,
	agentColorAmong,
	distinctAgentColors,
	buildSidebarGroups,
	dayLabel,
	deployedVersion,
	formatClockTime,
	formatRelative,
	groupMessagesByDay,
	highlightSegments,
	conversationQueryPrefix,
	formatFileSize,
	messageHref,
	queryWithin,
	searchSortFrom,
	plainSnippetText,
	snippetAround,
	isServerSessionEnded,
	loginHref,
	normalizePathname,
	positiveIntegerFrom,
	sanitizeNextPath,
	scopeHref,
	searchSummary,
	sortConversations,
} from './helpers';
import { codeChallengeFor, randomBase64Url } from './pkce';
import type { Conversation, Message } from './types';

const nowMs = Date.parse('2026-09-30T10:20:00.000Z');

function isoMinutesAgo(minutesAgo: number): string {
	return new Date(nowMs - minutesAgo * 60_000).toISOString();
}

function conversationNamed(name: string, messagesToday: number, lastActivity: string | null, overrides: Partial<Conversation> = {}): Conversation {
	return {
		id: name,
		name,
		kind: 'public',
		isPrivate: false,
		isDefault: false,
		topic: '',
		members: [],
		people: 1,
		messagesToday,
		lastActivity,
		isMine: false,
		pins: 0,
		unread: 0,
		lastReadSeq: 0,
		preview: '',
		...overrides,
	};
}

function messageAt(time: string): Message {
	return {
		seq: 1,
		person: 'maya',
		personEmail: 'maya@example.com',
		agent: 'claude-code',
		handle: 'maya/claude-code',
		time,
		text: '',
		isOwn: false,
		threadReplies: 0,
		lastReplyAt: null,
		threadRootSeq: null,
		alsoInChannel: false,
		editedAt: null,
		deleted: false,
		pinned: null,
		unreadReplies: 0,
		reactions: [],
		files: [],
	};
}

describe('formatRelative', () => {
	it('uses minutes under an hour, hours under a day, then days', () => {
		expect(formatRelative(isoMinutesAgo(59), nowMs)).toBe('59m');
		expect(formatRelative(isoMinutesAgo(60), nowMs)).toBe('1h');
		expect(formatRelative(isoMinutesAgo(1439), nowMs)).toBe('23h');
		expect(formatRelative(isoMinutesAgo(2880), nowMs)).toBe('2d');
	});

	it('shows a dash when a conversation has no activity', () => {
		expect(formatRelative(null, nowMs)).toBe('—');
	});

	it('never goes negative when the server clock runs ahead', () => {
		expect(formatRelative(isoMinutesAgo(-5), nowMs)).toBe('0m');
	});
});

describe('message times and day dividers', () => {
	it('formats message times as UTC hours and minutes', () => {
		expect(formatClockTime('2026-09-30T09:05:59.000Z')).toBe('09:05');
	});

	it('labels the current UTC date as today and other dates by ISO date', () => {
		expect(dayLabel('2026-09-30T00:00:00.000Z', nowMs)).toBe('today');
		expect(dayLabel('2026-09-29T23:59:59.000Z', nowMs)).toBe('2026-09-29');
	});

	it('starts a new day group whenever the UTC date changes', () => {
		const days = groupMessagesByDay([
			messageAt('2026-09-29T22:00:00.000Z'),
			messageAt('2026-09-29T23:00:00.000Z'),
			messageAt('2026-09-30T08:00:00.000Z'),
		], nowMs);
		expect(days.map((day) => [day.label, day.messages.length])).toEqual([['2026-09-29', 2], ['today', 1]]);
	});
});

const hueOf = (color: string) => Number(color.match(/^oklch\(0\.8 0\.12 ([\d.]+)\)$/)![1]);
const hueDistance = (first: number, second: number) => Math.min(Math.abs(first - second), 360 - Math.abs(first - second));
const manyHandles = Array.from({ length: 400 }, (_, index) => `person-${index}/agent-${index * 7}`);

describe('agentColor', () => {
	it('gives the same handle the same agent color every time', () => {
		expect(agentColor('ian.m/deploy-bot')).toBe(agentColor('@IAN.M/deploy-bot'));
	});

	it('spreads many handles across the hue spectrum', () => {
		const hueBuckets = new Set(manyHandles.map((handle) => Math.floor(hueOf(agentColor(handle)) / 10)));
		expect(hueBuckets.size).toBeGreaterThan(20);
	});

	it('never uses a hue near the amber accent or the danger red', () => {
		for (const handle of manyHandles) {
			const hue = hueOf(agentColor(handle));
			expect(hue >= 100 || hue < 5).toBe(true);
		}
	});
});

describe('distinctAgentColors', () => {
	it('keeps a few authors at least 45 degrees of hue apart', () => {
		const hues = [...distinctAgentColors(['ian.m/web-designer', 'li.p/codex-reviewer', 'sara.k/deploy-agent', 'john.w/backchannels-builder']).values()].map(hueOf);
		for (const [index, hue] of hues.entries()) {
			for (const otherHue of hues.slice(index + 1)) expect(hueDistance(hue, otherHue)).toBeGreaterThanOrEqual(45);
		}
	});

	it('keeps ten authors in a conversation at least 20 degrees of hue apart', () => {
		const handles = ['ian.m/backchannels-maintainer', 'john.w/backchannel-dev-iksxop', 'ian.m/posthog-web', 'john.w/backchannel-dev', 'maya/claude', 'dan/codex', 'li.p/codex-reviewer', 'sara.k/deploy-agent', 'tom.h/billing-agent', 'priya/cursor'];
		const hues = [...distinctAgentColors([...handles, ...handles]).values()].map(hueOf);
		expect(hues).toHaveLength(handles.length);
		for (const [index, hue] of hues.entries()) {
			for (const otherHue of hues.slice(index + 1)) expect(hueDistance(hue, otherHue)).toBeGreaterThanOrEqual(20);
		}
	});

	it('keeps an author on its hashed color when nobody else claims it', () => {
		expect(distinctAgentColors(['ian.m/deploy-bot']).get('ian.m/deploy-bot')).toBe(agentColor('ian.m/deploy-bot'));
	});

	it('resolves a handle written with a leading @ or different case to its mapped author color', () => {
		const colorByHandle = distinctAgentColors(['ian.m/deploy-bot', 'maya/claude']);
		expect(agentColorAmong(colorByHandle, '@IAN.M/Deploy-Bot')).toBe(colorByHandle.get('ian.m/deploy-bot'));
	});
});

describe('highlightSegments', () => {
	it('highlights every range and keeps the text between them', () => {
		expect(highlightSegments('cookie write throws cookie', [[20, 26], [0, 6]])).toEqual([
			{ text: 'cookie', isMatch: true },
			{ text: ' write throws ', isMatch: false },
			{ text: 'cookie', isMatch: true },
		]);
	});

	it('merges overlapping and touching ranges into one highlight', () => {
		expect(highlightSegments('abcdefgh', [[1, 3], [2, 5], [5, 6]])).toEqual([
			{ text: 'a', isMatch: false },
			{ text: 'bcdef', isMatch: true },
			{ text: 'gh', isMatch: false },
		]);
	});

	it('ignores empty ranges and clamps ranges past the end of the text', () => {
		expect(highlightSegments('abc', [[1, 1], [2, 10]])).toEqual([
			{ text: 'ab', isMatch: false },
			{ text: 'c', isMatch: true },
		]);
	});

	it('returns the whole text unhighlighted without ranges', () => {
		expect(highlightSegments('plain', [])).toEqual([{ text: 'plain', isMatch: false }]);
	});
});

describe('sortConversations', () => {
	const quietRecent = conversationNamed('#b', 1, isoMinutesAgo(5));
	const busyOld = conversationNamed('#c', 40, isoMinutesAgo(90));
	const busyRecent = conversationNamed('#a', 40, isoMinutesAgo(10));
	const neverActive = conversationNamed('#d', 0, null);

	it('orders most active first and breaks ties by recency', () => {
		expect(sortConversations([quietRecent, busyOld, busyRecent], 'active', nowMs).map((conversation) => conversation.name)).toEqual(['#a', '#c', '#b']);
	});

	it('orders by recency with never-active conversations last', () => {
		expect(sortConversations([neverActive, busyOld, busyRecent, quietRecent], 'recent', nowMs).map((conversation) => conversation.name)).toEqual(['#b', '#a', '#c', '#d']);
	});

	it('orders by name', () => {
		expect(sortConversations([busyOld, quietRecent, busyRecent], 'name', nowMs).map((conversation) => conversation.name)).toEqual(['#a', '#b', '#c']);
	});

	it('leaves the input array unchanged', () => {
		const original = [quietRecent, busyRecent];
		sortConversations(original, 'name', nowMs);
		expect(original).toEqual([quietRecent, busyRecent]);
	});
});

describe('buildSidebarGroups', () => {
	const publicConversations = Array.from({ length: 8 }, (_, index) => conversationNamed(`#channel-${index}`, index, isoMinutesAgo(index)));
	const privateConversations = [conversationNamed('dm-a', 0, isoMinutesAgo(30), { kind: 'dm', isPrivate: true })];

	it('caps each group at six and counts only channels my agents are in under my agents', () => {
		const [publicGroup, privateGroup] = buildSidebarGroups({ public: publicConversations, private: privateConversations }, { public: 40, publicMine: 8, private: 3 }, 'mine', nowMs);
		expect(publicGroup.conversations).toHaveLength(6);
		expect(publicGroup.total).toBe(8);
		expect(privateGroup.conversations).toHaveLength(1);
		expect(privateGroup.total).toBe(3);
	});

	it('lists default channels first, then the three highest ranked other channels', () => {
		const defaultChannels = ['#general', '#help'].map((name) => conversationNamed(name, 0, isoMinutesAgo(60), { isDefault: true }));
		const [publicGroup] = buildSidebarGroups({ public: [...publicConversations, ...defaultChannels], private: [] }, { public: 10, publicMine: 10, private: 0 }, 'everyone', nowMs);
		expect(publicGroup.conversations.map((conversation) => conversation.name)).toEqual(['#general', '#help', '#channel-7', '#channel-6', '#channel-5']);
		expect(publicGroup.hiddenCount).toBe(5);
	});

	it('never hides a conversation with unread messages behind the sidebar cap', () => {
		const quietUnreadChannel = conversationNamed('#quiet-unread', 0, isoMinutesAgo(600), { unread: 2 });
		const [publicGroup, privateGroup] = buildSidebarGroups({ public: [...publicConversations, quietUnreadChannel], private: privateConversations }, { public: 9, publicMine: 9, private: 1 }, 'mine', nowMs);
		expect(publicGroup.conversations.at(-1)?.name).toBe('#quiet-unread');
		expect(publicGroup.conversations).toHaveLength(7);
		expect(publicGroup.hiddenCount).toBe(2);
		expect(privateGroup.conversations).toHaveLength(1);
	});

	it('counts every public channel under everyone', () => {
		const [publicGroup] = buildSidebarGroups({ public: publicConversations, private: [] }, { public: 40, publicMine: 8, private: 0 }, 'everyone', nowMs);
		expect(publicGroup.total).toBe(40);
	});

	it('orders public channels by activity for everyone and by recency for mine', () => {
		const [everyonePublic] = buildSidebarGroups({ public: publicConversations, private: [] }, { public: 8, publicMine: 8, private: 0 }, 'everyone', nowMs);
		const [minePublic] = buildSidebarGroups({ public: publicConversations, private: [] }, { public: 8, publicMine: 8, private: 0 }, 'mine', nowMs);
		expect(everyonePublic.conversations[0].name).toBe('#channel-7');
		expect(minePublic.conversations[0].name).toBe('#channel-0');
		expect(minePublic.title).toBe('CHANNELS');
	});

	it('shows private chats only under my agents because private visibility never widens', () => {
		const everyoneGroups = buildSidebarGroups({ public: [], private: privateConversations }, { public: 0, publicMine: 0, private: 1 }, 'everyone', nowMs);
		const mineGroups = buildSidebarGroups({ public: [], private: privateConversations }, { public: 0, publicMine: 0, private: 1 }, 'mine', nowMs);
		expect(everyoneGroups.map((group) => group.kind)).toEqual(['public']);
		expect(mineGroups.map((group) => group.kind)).toEqual(['public', 'private']);
		expect(mineGroups[1].title).toBe('PRIVATE CHATS');
	});
});

describe('scopeHref', () => {
	it('sends the private directory to the public directory when switching to everyone', () => {
		expect(scopeHref(new URL('https://x.test/browse/private?scope=mine'), 'everyone')).toBe('/browse/public?scope=everyone');
	});

	it('drops the cursor when the directory changes because it offsets into the old listing', () => {
		expect(scopeHref(new URL('https://x.test/browse/private?scope=mine&cursor=50'), 'everyone')).toBe('/browse/public?scope=everyone');
	});

	it('keeps the cursor when the directory stays the same', () => {
		expect(scopeHref(new URL('https://x.test/browse/private?scope=everyone&cursor=50'), 'mine')).toBe('/browse/private?scope=mine&cursor=50');
	});

	it('keeps the private directory when switching to mine', () => {
		expect(scopeHref(new URL('https://x.test/browse/private?scope=everyone'), 'mine')).toBe('/browse/private?scope=mine');
	});

	it('keeps conversation pages on the same path', () => {
		expect(scopeHref(new URL('https://x.test/c/abc?scope=mine'), 'everyone')).toBe('/c/abc?scope=everyone');
	});
});

describe('sanitizeNextPath', () => {
	it('keeps app paths with their query', () => {
		expect(sanitizeNextPath('/c/dm%3Ak7f2?scope=everyone')).toBe('/c/dm%3Ak7f2?scope=everyone');
		expect(sanitizeNextPath('/')).toBe('/');
	});

	it('falls back to the app home for anything that could leave the site or loop through sign-in', () => {
		for (const unsafePath of [null, '', 'https://evil.example/c', '//evil.example/c', '/\\evil.example/c', '/login', '/logout', 'c/deploys', '/callback?code=1', '/c/../login', '/callback/']) {
			expect(sanitizeNextPath(unsafePath)).toBe('/');
		}
	});

	it('round-trips through the login link built for the current page', () => {
		const loginUrl = new URL(loginHref(new URL('https://app.backchannels.dev/c/deploys?scope=mine')), 'https://app.backchannels.dev');
		expect(loginUrl.pathname).toBe('/login');
		expect(sanitizeNextPath(loginUrl.searchParams.get('next'))).toBe('/c/deploys?scope=mine');
	});
});

describe('normalizePathname', () => {
	it('strips a single trailing slash', () => {
		expect(normalizePathname('/login/')).toBe('/login');
		expect(normalizePathname('/callback/')).toBe('/callback');
	});

	it('keeps the root path as a slash', () => {
		expect(normalizePathname('/')).toBe('/');
	});

	it('leaves slashless paths unchanged', () => {
		expect(normalizePathname('/callback')).toBe('/callback');
	});
});

describe('pkce', () => {
	it('makes a verifier long enough for the PKCE minimum of 43 characters', () => {
		expect(randomBase64Url(32)).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});

	it('derives the S256 challenge as the base64url SHA-256 of the verifier', async () => {
		const codeVerifier = randomBase64Url(48);
		expect(await codeChallengeFor(codeVerifier)).toBe(createHash('sha256').update(codeVerifier).digest('base64url'));
	});
});

describe('search helpers', () => {
	it('reads the sort from the URL and defaults to relevant', () => {
		expect(searchSortFrom(new URL('https://x.test/search?sort=recent'))).toBe('recent');
		expect(searchSortFrom(new URL('https://x.test/search?sort=bogus'))).toBe('relevant');
	});
	it('prefixes a query with its conversation once', () => {
		const prefix = conversationQueryPrefix('deploys', true);
		expect(prefix).toBe('in:#deploys');
		expect(conversationQueryPrefix('dm:k7f2', false)).toBe('in:dm:k7f2');
		expect(queryWithin(' rollback ', prefix)).toBe('in:#deploys rollback');
		expect(queryWithin('in:#deploys rollback', prefix)).toBe('in:#deploys rollback');
		expect(queryWithin('rollback', null)).toBe('rollback');
	});
	it('links a message into its thread unless it is also in the channel', () => {
		const channelMessage = { seq: 7, threadRootSeq: null, alsoInChannel: false };
		expect(messageHref('deploys', 'mine', channelMessage)).toBe('/c/deploys?scope=mine&around=7#m-7');
		expect(messageHref('deploys', 'mine', { seq: 9, threadRootSeq: 4, alsoInChannel: false })).toBe('/c/deploys?scope=mine&thread=4&around=9#m-9');
		expect(messageHref('deploys', 'mine', { seq: 9, threadRootSeq: 4, alsoInChannel: true })).toBe('/c/deploys?scope=mine&around=9#m-9');
	});
	it('cuts long text around the first match and shifts the ranges', () => {
		const text = `${'a'.repeat(1000)}needle${'b'.repeat(1000)}`;
		const snippet = snippetAround(text, [[1000, 1006]], 50);
		expect(snippet.text.startsWith('…')).toBe(true);
		expect(snippet.text.endsWith('…')).toBe(true);
		const [[start, end]] = snippet.ranges;
		expect(snippet.text.slice(start, end)).toBe('needle');
	});
	it('keeps short text whole', () => {
		expect(snippetAround('short needle', [[6, 12]])).toEqual({ text: 'short needle', ranges: [[6, 12]] });
	});
});

describe('plainSnippetText', () => {
	it('blanks markdown markup without moving any character', () => {
		const text = '## Fix\n**Run** `pnpm deploy` then see [the docs](https://x.test/a) or ```sh';
		const plain = plainSnippetText(text);
		expect(plain.length).toBe(text.length);
		expect(plain.replace(/\s+/g, ' ').trim()).toBe('Fix Run pnpm deploy then see the docs or');
		expect(plain.indexOf('pnpm deploy')).toBe(text.indexOf('pnpm deploy'));
		expect(plain.indexOf('the docs')).toBe(text.indexOf('the docs'));
	});
});

describe('formatFileSize', () => {
	it('uses bytes, then one decimal under ten, then whole units', () => {
		expect(formatFileSize(9)).toBe('9 B');
		expect(formatFileSize(1536)).toBe('1.5 KB');
		expect(formatFileSize(5 * 1024 * 1024)).toBe('5.0 MB');
		expect(formatFileSize(40 * 1024)).toBe('40 KB');
	});
});

describe('searchSummary', () => {
	it('gives totals on a single first page', () => {
		expect(searchSummary({ matchCount: 3, conversationCount: 2, hasNextCursor: false })).toBe('3 messages in 2 conversations.');
	});

	it('scopes the first page to its range when more pages follow', () => {
		expect(searchSummary({ matchCount: 25, conversationCount: 4, hasNextCursor: true })).toBe('Showing matches 1–25.');
	});

	it('offsets the range by the numeric cursor', () => {
		expect(searchSummary({ matchCount: 10, conversationCount: 2, cursor: '25', hasNextCursor: false })).toBe('Showing matches 26–35.');
	});

	it('offsets the range by a search cursor', () => {
		expect(searchSummary({ matchCount: 10, conversationCount: 2, cursor: 's41.50', hasNextCursor: false })).toBe('Showing matches 51–60.');
	});

	it('falls back to a plain count when the cursor is not numeric', () => {
		expect(searchSummary({ matchCount: 10, conversationCount: 2, cursor: 'abc', hasNextCursor: false })).toBe('Showing 10 matches.');
	});
});

describe('isServerSessionEnded', () => {
	it('treats a confirmed revocation as ended', () => {
		expect(isServerSessionEnded({ ok: true, value: null })).toBe(true);
	});

	it('treats a grant that is already gone as ended', () => {
		expect(isServerSessionEnded({ ok: false, error: 'unauthorized' })).toBe(true);
	});

	it('treats an unreachable api as not ended', () => {
		expect(isServerSessionEnded('unreachable')).toBe(false);
	});

	it('treats a rejected revocation request as not ended', () => {
		expect(isServerSessionEnded({ ok: false, error: 'invalid' })).toBe(false);
		expect(isServerSessionEnded({ ok: false, error: 'not_found' })).toBe(false);
	});
});

describe('positiveIntegerFrom', () => {
	it('reads a positive integer query parameter', () => {
		expect(positiveIntegerFrom('42')).toBe(42);
	});

	it('ignores missing, zero, negative, fractional and non-numeric values', () => {
		for (const parameter of [null, '', '0', '-3', '1.5', 'abc', '9007199254740993']) {
			expect(positiveIntegerFrom(parameter)).toBeUndefined();
		}
	});
});

describe('deployedVersion', () => {
	it('shows the deploy tag when the deploy script set one', () => {
		expect(deployedVersion({ id: '9e01f918-52a9-4328-8efe-f5a14e727e4d', tag: '1b01f99' })).toBe('1b01f99');
	});

	it('falls back to the short Cloudflare version id for untagged deploys', () => {
		expect(deployedVersion({ id: '9e01f918-52a9-4328-8efe-f5a14e727e4d', tag: '' })).toBe('9e01f918');
	});
});
