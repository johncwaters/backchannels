<script lang="ts">
	import type { Snippet } from 'svelte';
	import { tick } from 'svelte';
	import { beforeNavigate } from '$app/navigation';
	import MenuIcon from '@lucide/svelte/icons/menu';
	import * as Sheet from '#lib/components/ui/sheet/index.ts';
	import { mobileScreenQuery } from '#lib/client/screen.ts';

	let { workspaceName, open = $bindable(false), sidebar }: { workspaceName: string; open?: boolean; sidebar: Snippet } = $props();

	let panel = $state<HTMLDivElement>();

	function setOpen(value: boolean): void {
		open = value && matchMedia(mobileScreenQuery).matches;
	}

	beforeNavigate(() => setOpen(false));

	$effect(() => {
		const mobileScreen = matchMedia(mobileScreenQuery);
		const closeOnDesktop = () => {
			if (!mobileScreen.matches) setOpen(false);
		};
		mobileScreen.addEventListener('change', closeOnDesktop);
		return () => mobileScreen.removeEventListener('change', closeOnDesktop);
	});
</script>

<Sheet.Root {open} onOpenChange={setOpen}>
	<div class="mobile-navigation">
		<strong class="min-w-0 truncate text-[13px] font-semibold">[{workspaceName}]</strong>
		<Sheet.Trigger class="inline-flex min-h-11 items-center justify-center gap-2 border border-secondary px-3 font-mono text-sm text-amber hover:bg-selection">
			<MenuIcon class="size-4" aria-hidden="true" />
			Conversations
		</Sheet.Trigger>
	</div>
	<Sheet.Content
		side="left"
		class="gap-0"
		onOpenAutoFocus={(event) => {
			event.preventDefault();
			void tick().then(() => panel?.querySelector<HTMLInputElement>('input[type="search"]')?.focus());
		}}
	>
		<Sheet.Header class="min-h-15 border-b border-secondary pr-15">
			<Sheet.Title class="text-sm text-amber">Workspace conversations</Sheet.Title>
			<Sheet.Description class="sr-only">Search and switch channels or private chats.</Sheet.Description>
		</Sheet.Header>
		<div bind:this={panel} class="flex min-h-0 grow flex-col" data-mobile-sidebar-host>
			{@render sidebar()}
		</div>
	</Sheet.Content>
</Sheet.Root>
