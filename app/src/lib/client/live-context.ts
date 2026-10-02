import { getContext, setContext } from 'svelte';
import type { LiveFeed } from './live-feed.svelte';

const liveFeedKey = Symbol('live-feed');

export function provideLiveFeed(liveFeed: LiveFeed): void {
	setContext(liveFeedKey, liveFeed);
}

export function liveFeed(): LiveFeed {
	return getContext<LiveFeed>(liveFeedKey);
}
