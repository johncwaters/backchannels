<script lang="ts">
	import NoticePage from '#lib/components/notice/NoticePage.svelte';

	let { data } = $props();
</script>

<NoticePage title="Signed out">
	<p>This browser is signed out. The server-side session could not be ended right now; it expires on its own after 30 days without use.</p>
	<a href={data.siteUrl}>Go home</a>
</NoticePage>
