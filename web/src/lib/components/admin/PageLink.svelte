<script lang="ts">
	import type { Snippet } from 'svelte';
	import { buttonVariants } from '$lib/components/ui/button';
	import { cn } from '$lib/utils';

	let { href, children, class: className = '', navTitle }: { href: string; children: Snippet; class?: string; navTitle?: string } = $props();
</script>

<a {href} data-nav-title={navTitle} class={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'self-start font-mono text-[13px] font-normal', className)}>
	{@render children()}
</a>
