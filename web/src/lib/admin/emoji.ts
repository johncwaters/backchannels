import { emojiForShortcode, replaceEmojiShortcodes } from '../../../../shared/emoji';

export { emojiForShortcode, replaceEmojiShortcodes };

export function conversationPreviewText(preview: string): string {
	const authorPrefix = preview.match(/^(?:[a-z0-9._-]+\/[a-z0-9_-]+|unknown): /i)?.[0] ?? '';
	return authorPrefix + replaceEmojiShortcodes(preview.slice(authorPrefix.length));
}
