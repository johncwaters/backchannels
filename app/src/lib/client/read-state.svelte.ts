import { SvelteMap } from 'svelte/reactivity';

// Unread counts the server confirmed after this browser marked messages read, keyed by conversation.
// They apply until the next sidebar load brings the same numbers.
export const confirmedUnread = new SvelteMap<string, number>();

export function unreadFor(conversation: { id: string; unread: number }): number {
	return confirmedUnread.get(conversation.id) ?? conversation.unread;
}
