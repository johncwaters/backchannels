import { describe, expect, it } from 'vitest';
import { FakeAdminApi } from './api';
import { buildSidebarGroups, findMatchOffsets, formatRelative, sortConversations, splitMatchText } from './helpers';
import type { Conversation } from './types';

function conversationNamed(name: string, messagesToday: number, minutesAgo: number): Conversation {
	return {
		id: name,
		name,
		topic: '',
		isPrivate: false,
		members: [],
		people: 1,
		messagesToday,
		minutesAgo,
		lastActivity: '',
		isMine: false,
		preview: '',
	};
}

describe('formatRelative', () => {
	it('uses minutes under an hour, hours under a day, then days', () => {
		expect(formatRelative(59)).toBe('59m');
		expect(formatRelative(60)).toBe('1h');
		expect(formatRelative(1439)).toBe('23h');
		expect(formatRelative(2880)).toBe('2d');
	});
});

describe('sortConversations', () => {
	const quietRecent = conversationNamed('#b', 1, 5);
	const busyOld = conversationNamed('#c', 40, 90);
	const busyRecent = conversationNamed('#a', 40, 10);

	it('orders most active first and breaks ties by recency', () => {
		expect(sortConversations([quietRecent, busyOld, busyRecent], 'active').map((conversation) => conversation.name)).toEqual(['#a', '#c', '#b']);
	});

	it('orders by recency', () => {
		expect(sortConversations([busyOld, busyRecent, quietRecent], 'recent').map((conversation) => conversation.name)).toEqual(['#b', '#a', '#c']);
	});

	it('orders by name', () => {
		expect(sortConversations([busyOld, quietRecent, busyRecent], 'name').map((conversation) => conversation.name)).toEqual(['#a', '#b', '#c']);
	});

	it('leaves the input array unchanged', () => {
		const original = [quietRecent, busyRecent];
		sortConversations(original, 'name');
		expect(original).toEqual([quietRecent, busyRecent]);
	});
});

describe('findMatchOffsets', () => {
	it('finds a case-insensitive match and keeps the original casing when split', () => {
		const text = 'The Cookie write throws';
		const offsets = findMatchOffsets(text, ' cookie ');
		expect(offsets).toEqual({ start: 4, end: 10 });
		expect(splitMatchText(text, offsets!)).toEqual({ before: 'The ', matched: 'Cookie', after: ' write throws' });
	});

	it('highlights exactly the match when lowercasing the text would change its length', () => {
		const text = 'İstanbul cookie';
		const offsets = findMatchOffsets(text, 'cookie');
		expect(splitMatchText(text, offsets!).matched).toBe('cookie');
	});

	it('treats regex metacharacters in the query literally', () => {
		expect(findMatchOffsets('a.b axb', 'a.b')).toEqual({ start: 0, end: 3 });
	});

	it('returns null for a blank query or no match', () => {
		expect(findMatchOffsets('anything', '   ')).toBeNull();
		expect(findMatchOffsets('anything', 'kafka')).toBeNull();
	});
});

describe('buildSidebarGroups', () => {
	it('caps each group at six and counts every conversation of its kind', async () => {
		const { conversations } = await new FakeAdminApi().listConversations('', { scope: 'everyone' });
		const [publicGroup, privateGroup] = buildSidebarGroups(conversations, 'everyone');
		expect(publicGroup.conversations).toHaveLength(6);
		expect(publicGroup.total).toBe(conversations.filter((conversation) => !conversation.isPrivate).length);
		expect(privateGroup.conversations).toHaveLength(6);
	});

	it('shows only conversations your agents are in when scoped to mine', async () => {
		const { conversations } = await new FakeAdminApi().listConversations('', { scope: 'everyone' });
		const groups = buildSidebarGroups(conversations, 'mine');
		expect(groups.flatMap((group) => group.conversations).every((conversation) => conversation.isMine)).toBe(true);
	});
});

describe('FakeAdminApi.search', () => {
	it('limits matches to conversations your agents are in when scoped to mine', async () => {
		const adminApi = new FakeAdminApi();
		const mine = await adminApi.search('', { query: 'cookie', scope: 'mine' });
		const everyone = await adminApi.search('', { query: 'cookie', scope: 'everyone' });
		expect(everyone.matches.length).toBeGreaterThan(mine.matches.length);
		expect(mine.matches.every((match) => match.conversation.isMine)).toBe(true);
	});
});
