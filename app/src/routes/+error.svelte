<script lang="ts">
	import { page } from '$app/state';
	import { copyByStatus, errorStatus } from '#lib/admin/error-copy.ts';
	import NoticePage from '#lib/components/notice/NoticePage.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';

	let status = $derived(errorStatus(page.status));
	let copy = $derived(copyByStatus[status]);
</script>

<NoticePage title={copy.title} description={copy.detail}>
	{#snippet actions()}
		{#if status === 500}<Button href={page.url.href} variant="outline" data-sveltekit-reload>Reload</Button>{/if}
		<Button href="/" variant="outline" data-sveltekit-reload>Open conversations</Button>
	{/snippet}
</NoticePage>
