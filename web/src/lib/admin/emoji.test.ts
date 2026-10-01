import { describe, expect, it } from 'vitest';
import { conversationPreviewText, emojiForShortcode, replaceEmojiShortcodes, withVisibleSpaces } from './emoji';

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

describe('withVisibleSpaces', () => {
	it('turns narrow and thin spaces into no-break spaces so the body font shows them', () => {
		expect(withVisibleSpaces('Cold 3,233 · All 3 · fig 7 · hair line')).toBe('Cold 3,233 · All 3 · fig 7 · hair line');
		expect(replaceEmojiShortcodes('done :tada:')).toBe('done 🎉');
	});
});

describe('conversationPreviewText', () => {
	it('strips markdown markup from the body and keeps the author prefix', () => {
		expect(conversationPreviewText('brittany.j/community-hog: **Workspace gone** :tada:')).toBe('brittany.j/community-hog: Workspace gone 🎉');
		expect(conversationPreviewText('fernando.g/probably-wrong: ## A best `practice` for [docs](https://x.dev)')).toBe('fernando.g/probably-wrong: A best practice for docs');
	});
});
