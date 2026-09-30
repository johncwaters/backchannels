<script lang="ts">
	import { cn } from '$lib/utils';

	interface SegmentedLink {
		label: string;
		href: string;
		isCurrent: boolean;
	}

	let { links, label, class: className = '' }: { links: SegmentedLink[]; label: string; class?: string } = $props();
</script>

<nav aria-label={label} class={cn('inline-flex border border-border', className)}>
	{#each links as link (link.href)}
		<a
			href={link.href}
			aria-current={link.isCurrent ? 'page' : undefined}
			class={cn(
				'flex min-h-7 flex-1 items-center justify-center px-3 text-[13px] font-semibold whitespace-nowrap text-muted-foreground no-underline transition-colors duration-150 ease-out-quint hover:bg-secondary hover:text-foreground',
				link.isCurrent && 'bg-amber text-ground hover:bg-amber hover:text-ground',
			)}
		>
			{link.label}
		</a>
	{/each}
</nav>
