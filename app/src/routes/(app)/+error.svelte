<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { page } from '$app/state';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import { adminHref, scopeFrom } from '#lib/admin/helpers.ts';
	import { copyByStatus, errorStatus } from '#lib/admin/error-copy.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as Empty from '#lib/components/ui/empty/index.ts';

	let status = $derived(errorStatus(page.status));
	let copy = $derived(copyByStatus[status]);
	let scope = $derived(scopeFrom(page.url));
	let isDirectoryError = $derived(status === 404 && page.url.pathname.startsWith('/browse/'));
</script>

<svelte:head>
	<title>{copy.title} · backchannels</title>
</svelte:head>

<Empty.Root class="grow">
	<Empty.Header>
		<Empty.Media variant="icon"><CircleAlertIcon /></Empty.Media>
		<Empty.Title><h1 class="m-0 text-[21px] font-semibold text-amber">{copy.title}</h1></Empty.Title>
		<Empty.Description class="font-sans">{copy.detail}</Empty.Description>
	</Empty.Header>
	<Empty.Content class="flex-row flex-wrap justify-center">
		{#if status === 500}<Button variant="outline" size="sm" onclick={() => refreshAll()}>Reload</Button>{/if}
		<Button href={adminHref('/', scope)} variant="outline" size="sm">Open conversations</Button>
		{#if isDirectoryError}
			<Button href={adminHref('/browse/public', scope)} variant="outline" size="sm">Browse public channels</Button>
			<Button href={adminHref('/browse/private', scope)} variant="outline" size="sm">Browse private chats</Button>
		{/if}
	</Empty.Content>
</Empty.Root>
