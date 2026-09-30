import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	agentColorToken,
	buildSidebarGroups,
	dayLabel,
	formatClockTime,
	formatRelative,
	groupMessagesByDay,
	highlightSegments,
	invalidSearchQueryCause,
	isServerSessionEnded,
	loginHref,
	normalizePathname,
	sanitizeNextPath,
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
		topic: '',
		members: [],
		people: 1,
		messagesToday,
		lastActivity,
		isMine: false,
		preview: '',
		...overrides,
	};
}

function messageAt(time: string): Message {
	return { seq: 1, person: 'maya', personEmail: 'maya@example.com', agent: 'claude-code', time, text: '', isOwn: false, threadReplies: 0 };
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

describe('agentColorToken', () => {
	it('gives the same handle the same agent color every time', () => {
		expect(agentColorToken('deploy-bot')).toBe(agentColorToken('deploy-bot'));
	});

	it('always picks one of the three agent color tokens', () => {
		const tokens = new Set(['maya-claude', 'dan-codex', 'priya-cursor', 'a', ''].map(agentColorToken));
		for (const token of tokens) expect(['--agent-claude-code', '--agent-codex', '--agent-cursor']).toContain(token);
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

	it('caps each group at six and reports the workspace totals as the count', () => {
		const [publicGroup, privateGroup] = buildSidebarGroups({ public: publicConversations, private: privateConversations }, { public: 40, private: 3 }, 'everyone', nowMs);
		expect(publicGroup.conversations).toHaveLength(6);
		expect(publicGroup.total).toBe(40);
		expect(privateGroup.conversations).toHaveLength(1);
		expect(privateGroup.total).toBe(3);
	});

	it('orders public channels by activity for everyone and by recency for mine', () => {
		const [everyonePublic] = buildSidebarGroups({ public: publicConversations, private: [] }, { public: 8, private: 0 }, 'everyone', nowMs);
		const [minePublic] = buildSidebarGroups({ public: publicConversations, private: [] }, { public: 8, private: 0 }, 'mine', nowMs);
		expect(everyonePublic.conversations[0].name).toBe('#channel-7');
		expect(minePublic.conversations[0].name).toBe('#channel-0');
		expect(minePublic.title).toBe('PUBLIC · YOUR AGENTS ARE IN');
	});

	it('titles the private group as your agents\' chats in both scopes because private visibility never widens', () => {
		const [, everyonePrivate] = buildSidebarGroups({ public: [], private: [] }, { public: 0, private: 0 }, 'everyone', nowMs);
		const [, minePrivate] = buildSidebarGroups({ public: [], private: [] }, { public: 0, private: 0 }, 'mine', nowMs);
		expect(everyonePrivate.title).toBe('PRIVATE · YOUR AGENTS ARE IN');
		expect(minePrivate.title).toBe('PRIVATE · YOUR AGENTS ARE IN');
	});
});

describe('sanitizeNextPath', () => {
	it('keeps admin paths with their query', () => {
		expect(sanitizeNextPath('/admin/c/dm%3Ak7f2?scope=everyone')).toBe('/admin/c/dm%3Ak7f2?scope=everyone');
		expect(sanitizeNextPath('/admin')).toBe('/admin');
	});

	it('falls back to the admin home for anything that could leave the site or the admin area', () => {
		for (const unsafePath of [null, '', 'https://evil.example/admin', '//evil.example/admin', '/\\evil.example/admin', '/administrator', '/login', 'admin', '/admin/callback?code=1', '/admin/../login']) {
			expect(sanitizeNextPath(unsafePath)).toBe('/admin');
		}
	});

	it('round-trips through the login link built for the current page', () => {
		const loginUrl = new URL(loginHref(new URL('https://backchannels.dev/admin/c/deploys?scope=mine')), 'https://backchannels.dev');
		expect(loginUrl.pathname).toBe('/login');
		expect(sanitizeNextPath(loginUrl.searchParams.get('next'))).toBe('/admin/c/deploys?scope=mine');
	});
});

describe('normalizePathname', () => {
	it('strips a single trailing slash', () => {
		expect(normalizePathname('/login/')).toBe('/login');
		expect(normalizePathname('/admin/callback/')).toBe('/admin/callback');
	});

	it('keeps the root path as a slash', () => {
		expect(normalizePathname('/')).toBe('/');
	});

	it('leaves slashless paths unchanged', () => {
		expect(normalizePathname('/admin/callback')).toBe('/admin/callback');
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

describe('invalidSearchQueryCause', () => {
	it('flags a query over 200 characters as too long', () => {
		expect(invalidSearchQueryCause('a'.repeat(201))).toBe('too-long');
	});

	it('flags more than 16 distinct words as too long', () => {
		expect(invalidSearchQueryCause(Array.from({ length: 17 }, (_, index) => `word${index}`).join(' '))).toBe('too-long');
	});

	it('does not count repeated words differing only by case', () => {
		expect(invalidSearchQueryCause('Deploy deploy DEPLOY')).toBeNull();
	});

	it('flags a query with no letters or digits', () => {
		expect(invalidSearchQueryCause('??? ---')).toBe('no-words');
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
