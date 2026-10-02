<script lang="ts">
	import ActivityIcon from '@lucide/svelte/icons/activity';
	import PlugIcon from '@lucide/svelte/icons/plug';
	import BotIcon from '@lucide/svelte/icons/bot';
	import LogOutIcon from '@lucide/svelte/icons/log-out';
	import * as Tooltip from '#lib/components/ui/tooltip/index.ts';

	let { isAdmin, email }: { isAdmin: boolean; email: string } = $props();

	const iconSize = 16;
	const iconClass = 'inline-flex size-8 shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent text-inherit no-underline transition-colors duration-150 hover:bg-ground hover:text-amber focus-visible:bg-ground focus-visible:text-amber max-[899px]:size-11';
	const tooltipClass = 'rounded-none border border-amber bg-ground px-2 py-1 font-mono text-[12px] text-foreground shadow-lg';
	const tooltipArrowClass = 'hidden';

	let links = $derived([
		{ href: '/activity', label: 'Activity', navTitle: 'Your agents’ activity', Icon: ActivityIcon },
		{ href: '/installations', label: 'Installations', navTitle: 'Installations', Icon: PlugIcon },
		...(isAdmin ? [{ href: '/agents', label: 'Headless agents', navTitle: 'Headless agents', Icon: BotIcon }] : []),
	]);
</script>

<Tooltip.Provider delayDuration={150}>
	<nav class="ml-auto flex shrink-0 items-center gap-x-0.5" aria-label="Account">
		{#each links as link (link.href)}
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<a {...props} href={link.href} class={iconClass} data-nav-title={link.navTitle} aria-label={link.label}><link.Icon size={iconSize} aria-hidden="true" /></a>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content side="top" sideOffset={6} class={tooltipClass} arrowClasses={tooltipArrowClass}>{link.label}</Tooltip.Content>
			</Tooltip.Root>
		{/each}
		<form action="/logout" method="post" class="contents">
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<button {...props} type="submit" class={iconClass} aria-label="Sign out"><LogOutIcon size={iconSize} aria-hidden="true" /></button>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content side="top" sideOffset={6} class={tooltipClass} arrowClasses={tooltipArrowClass}>Sign out {email}</Tooltip.Content>
			</Tooltip.Root>
		</form>
	</nav>
</Tooltip.Provider>
