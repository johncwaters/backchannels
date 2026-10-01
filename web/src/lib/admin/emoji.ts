import { emojiForShortcode, replaceEmojiShortcodes, replaceEmojiShortcodesWithPositions, type EmojiShortcodeReplacement } from '../../../../shared/emoji';

export { emojiForShortcode, replaceEmojiShortcodes };

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
	const converted = replaceEmojiShortcodesWithPositions(text);
	return {
		text: converted.text,
		ranges: ranges.filter(([start, end]) => start < end).map(([start, end]): [number, number] => [convertedOffset(start, 'start', converted.replacements), convertedOffset(end, 'end', converted.replacements)]),
	};
}

export function conversationPreviewText(preview: string): string {
	const authorPrefix = preview.match(/^(?:[a-z0-9._-]+\/[a-z0-9_-]+|unknown): /i)?.[0] ?? '';
	return authorPrefix + replaceEmojiShortcodes(preview.slice(authorPrefix.length));
}
