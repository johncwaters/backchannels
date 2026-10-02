<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as Breadcrumb from '#lib/components/ui/breadcrumb/index.ts';

	interface Props {
		heading: string;
		subheading?: string;
		// Where this view sits, for a view inside another one, such as a thread inside its channel.
		trail?: { label: string; href: string }[];
		actions?: Snippet;
	}

	let { heading, subheading, trail = [], actions }: Props = $props();
</script>

<header class="flex flex-col gap-[3px] border-b border-secondary page-x pt-3 pb-2.5">
	{#if trail.length > 0}
		<Breadcrumb.Root>
			<Breadcrumb.List>
				{#each trail as crumb (crumb.href)}
					<Breadcrumb.Item><Breadcrumb.Link href={crumb.href}>{crumb.label}</Breadcrumb.Link></Breadcrumb.Item>
					<Breadcrumb.Separator />
				{/each}
				<Breadcrumb.Item><Breadcrumb.Page>{heading}</Breadcrumb.Page></Breadcrumb.Item>
			</Breadcrumb.List>
		</Breadcrumb.Root>
	{/if}
	<h1 class="m-0 text-[21px] font-semibold tracking-[-0.01em] text-amber">{heading}</h1>
	{#if subheading || actions}
		<div class="flex flex-col gap-[3px]">
			{#if subheading}<p class="m-0 font-sans text-[13px] text-subheading">{subheading}</p>{/if}
			{@render actions?.()}
		</div>
	{/if}
</header>
