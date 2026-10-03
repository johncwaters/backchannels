import { createSubscriber } from 'svelte/reactivity';

const tickMs = 15_000;

const subscribeToTicks = createSubscriber((update) => {
	const timer = setInterval(update, tickMs);
	return () => clearInterval(timer);
});

export function currentTimeMs(): number {
	subscribeToTicks();
	return Date.now();
}
