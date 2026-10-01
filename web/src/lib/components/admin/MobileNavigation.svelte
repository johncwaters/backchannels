<script lang="ts">
	import { onMount, tick } from 'svelte';
	import MenuIcon from '@lucide/svelte/icons/menu';
	import * as Sheet from '$lib/components/ui/sheet';

	let { workspaceName }: { workspaceName: string } = $props();
	let open = $state(false);
	let ready = $state(false);
	let sidebarHost = $state<HTMLDivElement>();
	let sidebar: HTMLElement | null = null;
	let sidebarHome: HTMLElement | null = null;
	let mobileScreen: MediaQueryList | undefined;

	function restoreSidebar(): void {
		if (!sidebar || !sidebarHome?.isConnected) return;
		sidebarHome.after(sidebar);
		sidebar.dataset.mobileSidebar = 'closed';
	}

	function setOpen(value: boolean): void {
		if (value && !mobileScreen?.matches) return;
		open = value;
		if (!value) restoreSidebar();
	}

	$effect(() => {
		if (!open || !sidebarHost || !sidebar) return;
		sidebarHost.append(sidebar);
		sidebar.dataset.mobileSidebar = 'open';
	});

	onMount(() => {
		sidebar = document.querySelector('[data-workspace-sidebar]');
		sidebarHome = document.querySelector('[data-sidebar-home]');
		if (!sidebar || !sidebarHome) return;
		mobileScreen = matchMedia('(max-width: 899px)');
		restoreSidebar();
		ready = true;
		const close = () => setOpen(false);
		const openNavigation = () => setOpen(true);
		const resize = () => { if (!mobileScreen?.matches) close(); };
		document.addEventListener('astro:before-preparation', close);
		document.addEventListener('admin:open-navigation', openNavigation);
		mobileScreen.addEventListener('change', resize);
		return () => {
			close();
			if (sidebar) delete sidebar.dataset.mobileSidebar;
			document.removeEventListener('astro:before-preparation', close);
			document.removeEventListener('admin:open-navigation', openNavigation);
			mobileScreen?.removeEventListener('change', resize);
		};
	});
</script>

<Sheet.Root {open} onOpenChange={setOpen}>
	<div class="mobile-navigation" data-ready={ready ? '' : undefined}>
		<strong class="min-w-0 truncate text-[13px] font-semibold">[{workspaceName}]</strong>
		<Sheet.Trigger class="inline-flex min-h-11 items-center justify-center gap-2 border border-secondary px-3 font-mono text-sm text-amber hover:bg-selection" disabled={!ready}>
			<MenuIcon class="size-4" aria-hidden="true" />
			Conversations
		</Sheet.Trigger>
	</div>
	<Sheet.Content side="left" class="gap-0" onOpenAutoFocus={(event) => {
		event.preventDefault();
		void tick().then(() => sidebar?.querySelector<HTMLInputElement>('input[type="search"]')?.focus());
	}}>
		<Sheet.Header class="min-h-15 border-b border-secondary pr-15">
			<Sheet.Title class="text-sm text-amber">Workspace conversations</Sheet.Title>
			<Sheet.Description class="sr-only">Search and switch channels or private chats.</Sheet.Description>
		</Sheet.Header>
		<div bind:this={sidebarHost} class="flex min-h-0 grow flex-col" data-mobile-sidebar-host></div>
	</Sheet.Content>
</Sheet.Root>
