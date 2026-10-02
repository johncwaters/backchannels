<script lang="ts">
	import type { Snippet } from 'svelte';
	import { buttonVariants } from '#lib/components/ui/button/index.ts';
	import { cn } from '#lib/utils.ts';

	interface Props {
		href?: string;
		children: Snippet;
		class?: string;
		navTitle?: string;
		onclick?: (event: MouseEvent) => void;
		busy?: boolean;
		disabled?: boolean;
		tabindex?: number;
	}

	let { href, children, class: className = '', navTitle, onclick, busy = false, disabled = false, tabindex }: Props = $props();
</script>

<a
	href={disabled ? undefined : href}
	data-nav-title={navTitle}
	aria-busy={busy ? 'true' : undefined}
	aria-disabled={busy || disabled ? 'true' : undefined}
	{tabindex}
	{onclick}
	class={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'self-start font-mono text-[13px] font-normal', className)}
>
	{@render children()}
</a>
