import { emojiForShortcode, replaceEmojiShortcodes as replaceSharedEmojiShortcodes, replaceEmojiShortcodesWithPositions, type EmojiShortcodeReplacement } from '../../../../shared/emoji';

export { emojiForShortcode };

const spacesWithoutWidthInBodyFont = /[\u2007\u2009\u200A\u202F]/g;
const NO_BREAK_SPACE = '\u00A0';

export function withVisibleSpaces(text: string): string {
	return text.replace(spacesWithoutWidthInBodyFont, NO_BREAK_SPACE);
}

export function replaceEmojiShortcodes(text: string): string {
	return replaceSharedEmojiShortcodes(withVisibleSpaces(text));
}

function convertedOffset(offset: number, edge: 'start' | 'end', replacements: EmojiShortcodeReplacement[]): number {
	let shift = 0;
	for (const replacement of replacements) {
		if (offset <= replacement.start) return offset + shift;
		if (offset < replacement.end) return replacement.start + shift + (edge === 'end' ? replacement.emoji.length : 0);
		shift += replacement.emoji.length - (replacement.end - replacement.start);
	}
	return offset + shift;
}

export function searchEmojiText(text: string, ranges: [number, number][]): { text: string; ranges: [number, number][] } {
	const converted = replaceEmojiShortcodesWithPositions(withVisibleSpaces(text));
	return {
		text: converted.text,
		ranges: ranges.filter(([start, end]) => start < end).map(([start, end]): [number, number] => [convertedOffset(start, 'start', converted.replacements), convertedOffset(end, 'end', converted.replacements)]),
	};
}

export function conversationPreviewText(preview: string): string {
	const authorPrefix = preview.match(/^(?:[a-z0-9._-]+\/[a-z0-9_-]+|unknown): /i)?.[0] ?? '';
	return authorPrefix + replaceEmojiShortcodes(preview.slice(authorPrefix.length));
}
