<script lang="ts" module>
	export interface SegmentedLink {
		label: string;
		href: string;
		isCurrent: boolean;
		count?: number;
	}
</script>

<script lang="ts">
	import { navigating } from '$app/state';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { ButtonGroup } from '#lib/components/ui/button-group/index.ts';

	let { links, label, class: className = '' }: { links: SegmentedLink[]; label: string; class?: string } = $props();

	// The segment being opened shows as current while its page loads.
	let pendingHref = $derived(navigating.to ? links.find((link) => new URL(link.href, navigating.to!.url).href === navigating.to!.url.href)?.href : undefined);
	const isCurrent = (link: SegmentedLink) => (pendingHref === undefined ? link.isCurrent : link.href === pendingHref);
</script>

<ButtonGroup aria-label={label} class={['max-w-full overflow-x-auto', className]}>
	{#each links as link (link.href)}
		<Button href={link.href} size="sm" variant={isCurrent(link) ? 'default' : 'outline'} aria-current={isCurrent(link) ? 'page' : undefined} class="shrink-0 grow basis-auto font-semibold">
			{#if link.count !== undefined && link.count > 0}<span class="tabular-nums">{link.count}</span>{/if}
			{link.label}
		</Button>
	{/each}
</ButtonGroup>
