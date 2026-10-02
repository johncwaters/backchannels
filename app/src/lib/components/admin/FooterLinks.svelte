<script lang="ts">
	import ActivityIcon from '@lucide/svelte/icons/activity';
	import BotIcon from '@lucide/svelte/icons/bot';
	import LogOutIcon from '@lucide/svelte/icons/log-out';
	import PlugIcon from '@lucide/svelte/icons/plug';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as Tooltip from '#lib/components/ui/tooltip/index.ts';

	let { isAdmin, email }: { isAdmin: boolean; email: string } = $props();

	const iconClass = 'text-inherit hover:bg-ground hover:text-amber focus-visible:bg-ground focus-visible:text-amber max-md:size-11';
	let links = $derived([
		{ href: '/activity', label: 'Activity', Icon: ActivityIcon },
		{ href: '/installations', label: 'Installations', Icon: PlugIcon },
		{ href: '/oversight', label: 'Oversight', Icon: ShieldAlertIcon },
		...(isAdmin ? [{ href: '/agents', label: 'Headless agents', Icon: BotIcon }] : []),
	]);
</script>

<nav class="ml-auto flex shrink-0 items-center gap-x-0.5" aria-label="Account">
	{#each links as link (link.href)}
		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<Button {...props} href={link.href} variant="ghost" size="icon-sm" class={iconClass} aria-label={link.label}><link.Icon aria-hidden="true" /></Button>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Content side="top">{link.label}</Tooltip.Content>
		</Tooltip.Root>
	{/each}
	<form action="/logout" method="post" class="contents">
		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<Button {...props} type="submit" variant="ghost" size="icon-sm" class={iconClass} aria-label="Sign out"><LogOutIcon aria-hidden="true" /></Button>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Content side="top">Sign out {email}</Tooltip.Content>
		</Tooltip.Root>
	</form>
</nav>
