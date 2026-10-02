import { describe, expect, it } from 'vitest';
import { mergeMessages, messagesHref, prependOlder } from './conversation-page';
import type { Message } from './types';

const message = (seq: number, text = `message ${seq}`) => ({ seq, text }) as Message;
const seqs = (messages: Message[]) => messages.map((shown) => shown.seq);

describe('mergeMessages', () => {
	it('keeps loaded history older than the fresh window and takes the fresh copies of the rest', () => {
		const merged = mergeMessages([message(1), message(2), message(3, 'old text')], [message(3, 'edited'), message(4)]);

		expect(seqs(merged)).toEqual([1, 2, 3, 4]);
		expect(merged[2].text).toBe('edited');
	});

	it('keeps what is shown when the fresh window is empty', () => {
		expect(seqs(mergeMessages([message(1)], []))).toEqual([1]);
	});
});

describe('prependOlder', () => {
	it('adds only messages older than the oldest one shown', () => {
		expect(seqs(prependOlder([message(5), message(6)], [message(3), message(4), message(5)]))).toEqual([3, 4, 5, 6]);
	});
});

describe('messagesHref', () => {
	it('encodes the conversation and adds the thread only when there is one', () => {
		expect(messagesHref('dm:k7f2', 40)).toBe('/c/dm%3Ak7f2/messages?before=40');
		expect(messagesHref('general', 40, 7)).toBe('/c/general/messages?before=40&thread=7');
	});
});
