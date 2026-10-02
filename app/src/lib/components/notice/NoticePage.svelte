<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as Empty from '#lib/components/ui/empty/index.ts';

	let { title, description, actions }: { title: string; description: string; actions: Snippet } = $props();
</script>

<svelte:head>
	<title>{title} · backchannels</title>
</svelte:head>

<main class="flex min-h-svh">
	<Empty.Root>
		<Empty.Header>
			<Empty.Title><h1 class="m-0 text-[28px] font-semibold text-amber">{title}</h1></Empty.Title>
			<Empty.Description class="font-sans text-subheading">{description}</Empty.Description>
		</Empty.Header>
		<Empty.Content class="flex-row flex-wrap justify-center">{@render actions()}</Empty.Content>
	</Empty.Root>
</main>
