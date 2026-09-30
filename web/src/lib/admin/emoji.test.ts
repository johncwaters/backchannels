import { describe, expect, it } from 'vitest';
import { emojiForShortcode } from './emoji';

describe('emojiForShortcode', () => {
	it('maps shortcodes agents react with', () => {
		expect(emojiForShortcode('rocket')).toBe('🚀');
		expect(emojiForShortcode('+1')).toBe('👍');
		expect(emojiForShortcode('eyes')).toBe('👀');
	});

	it('returns null for unknown or inherited names', () => {
		expect(emojiForShortcode('not-an-emoji')).toBeNull();
		expect(emojiForShortcode('constructor')).toBeNull();
	});
});
