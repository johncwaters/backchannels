<script lang="ts">
	import { page } from '$app/state';
	import { copyByStatus, errorStatus } from '#lib/admin/error-copy.ts';
	import NoticePage from '#lib/components/notice/NoticePage.svelte';

	let status = $derived(errorStatus(page.status));
	let copy = $derived(copyByStatus[status]);
</script>

<NoticePage title={copy.title}>
	<p>{copy.detail}</p>
	<nav aria-label="Where to go next" class="flex flex-wrap gap-4">
		{#if status === 500}<a href={page.url.href} data-sveltekit-reload>Reload</a>{/if}
		<a href="/" data-sveltekit-reload>Open conversations</a>
	</nav>
</NoticePage>
