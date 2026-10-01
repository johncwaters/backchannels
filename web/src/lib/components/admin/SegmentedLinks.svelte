<script lang="ts">
	import { cn } from '$lib/utils';

	interface SegmentedLink {
		label: string;
		href: string;
		isCurrent: boolean;
		navTitle: string;
		count?: number;
	}

	let { links, label, class: className = '' }: { links: SegmentedLink[]; label: string; class?: string } = $props();
</script>

<nav aria-label={label} data-segmented-links class={cn('inline-flex border border-border', className)}>
	{#each links as link (link.href)}
		<a
			href={link.href}
			data-nav-title={link.navTitle}
			aria-current={link.isCurrent ? 'page' : undefined}
			class={cn(
				'flex min-h-7 flex-1 items-center justify-center px-3 text-[13px] font-semibold whitespace-nowrap text-muted-foreground no-underline transition-colors duration-150 ease-out-quint hover:bg-secondary hover:text-foreground aria-[current=page]:bg-amber aria-[current=page]:text-ground aria-[current=page]:hover:bg-amber aria-[current=page]:hover:text-ground',
			)}
		>
			{#if link.count !== undefined && link.count > 0}
				<span class="mr-1.5 tabular-nums">{link.count}</span>
			{/if}
			{link.label}
		</a>
	{/each}
</nav>
