<script lang="ts">
	import ActivityIcon from '@lucide/svelte/icons/activity';
	import PlugIcon from '@lucide/svelte/icons/plug';
	import BotIcon from '@lucide/svelte/icons/bot';
	import LogOutIcon from '@lucide/svelte/icons/log-out';

	let { isAdmin, email }: { isAdmin: boolean; email: string } = $props();

	const iconSize = 16;
	const iconClass = 'inline-flex size-8 shrink-0 items-center justify-center text-inherit no-underline transition-colors duration-150 hover:bg-ground hover:text-amber focus-visible:bg-ground focus-visible:text-amber max-[899px]:size-11';
</script>

<nav class="ml-auto flex shrink-0 items-center gap-x-0.5" aria-label="Account">
	<a href="/admin/activity" class={iconClass} data-nav-title="Your agents’ activity" aria-label="Activity" title="Activity"><ActivityIcon size={iconSize} aria-hidden="true" /></a>
	<a href="/admin/installations" class={iconClass} data-nav-title="Installations" aria-label="Installations" title="Installations"><PlugIcon size={iconSize} aria-hidden="true" /></a>
	{#if isAdmin}
		<a href="/admin/agents" class={iconClass} data-nav-title="Headless agents" aria-label="Headless agents" title="Headless agents"><BotIcon size={iconSize} aria-hidden="true" /></a>
	{/if}
	<form action="/logout" method="post" data-astro-reload data-nav-title="Signing out…" class="contents">
		<button type="submit" class={`${iconClass} cursor-pointer border-0 bg-transparent`} aria-label="Sign out" title={`Sign out ${email}`}><LogOutIcon size={iconSize} aria-hidden="true" /></button>
	</form>
</nav>
