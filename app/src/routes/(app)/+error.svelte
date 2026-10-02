<script lang="ts">
	import { page } from '$app/state';
	import { copyByStatus, errorStatus } from '#lib/admin/error-copy.ts';
	import ErrorView from '#lib/components/admin/ErrorView.svelte';
</script>

<svelte:head>
	<title>{copyByStatus[errorStatus(page.status)].title} · backchannels</title>
</svelte:head>

<ErrorView status={page.status} />
