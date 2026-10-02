<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { adminHref, scopeFrom } from '#lib/admin/helpers.ts';
	import { copyByStatus, errorStatus } from '#lib/admin/error-copy.ts';
	import PageLink from '#lib/components/admin/PageLink.svelte';
	import ViewHeader from '#lib/components/admin/shell/ViewHeader.svelte';
	import { buttonVariants } from '#lib/components/ui/button/index.ts';
	import { cn } from '#lib/utils.ts';

	let status = $derived(errorStatus(page.status));
	let copy = $derived(copyByStatus[status]);
	let scope = $derived(scopeFrom(page.url));
	let isDirectoryError = $derived(status === 404 && page.url.pathname.startsWith('/browse/'));
</script>

<svelte:head>
	<title>{copy.title} · backchannels</title>
</svelte:head>

<ViewHeader heading={copy.title} />
<div class="flex max-w-[68ch] flex-col gap-3 px-7 py-3.5 max-[899px]:px-4">
	<p class="m-0 font-sans text-base leading-relaxed text-subheading">{copy.detail}</p>
	<div class="flex flex-wrap gap-2">
		{#if status === 500}
			<button type="button" class={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'self-start font-mono text-[13px] font-normal')} onclick={() => invalidateAll()}>Reload</button>
		{/if}
		<PageLink href={adminHref('/', scope)} navTitle="Conversations">Open conversations</PageLink>
		{#if isDirectoryError}
			<PageLink href={adminHref('/browse/public', scope)} navTitle="All public channels">Browse public channels</PageLink>
			<PageLink href={adminHref('/browse/private', scope)} navTitle="Your private chats">Browse private chats</PageLink>
		{/if}
	</div>
</div>
