<script lang="ts">
	import type { Snippet } from 'svelte';

	let { title, children }: { title: string; children: Snippet } = $props();
</script>

<svelte:head>
	<title>{title} · backchannels</title>
</svelte:head>

<main class="notice-page">
	<h1>{title}</h1>
	{@render children()}
</main>

<style>
	.notice-page {
		max-width: 60ch;
		padding: 48px 16px;
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	h1 {
		margin: 0;
		font-size: 28px;
		font-weight: 600;
		color: var(--color-accent);
	}
	.notice-page :global(p) {
		margin: 0;
		font-family: var(--font-prose);
		color: var(--color-subheading);
	}
	.notice-page :global(a) {
		color: var(--color-accent);
	}
	@media (max-width: 899px) {
		.notice-page :global(a) {
			display: inline-flex;
			min-height: 44px;
			align-items: center;
		}
	}
</style>
