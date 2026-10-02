<script lang="ts">
	import NoticePage from '#lib/components/notice/NoticePage.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';

	let { data } = $props();
</script>

<NoticePage title="Signed out" description="This browser is signed out. The server-side session could not be ended right now; it expires on its own after 30 days without use.">
	{#snippet actions()}<Button href={data.siteUrl} variant="outline">Go home</Button>{/snippet}
</NoticePage>
