import { nameToEmoji } from 'gemoji';

export function emojiForShortcode(shortcode: string): string | null {
	return Object.hasOwn(nameToEmoji, shortcode) ? nameToEmoji[shortcode] : null;
}
