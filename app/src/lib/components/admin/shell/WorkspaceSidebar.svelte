<script lang="ts">
	import { Input } from '#lib/components/ui/input/index.ts';
	import type { AdminFrame } from '#lib/admin/frame.ts';
	import type { DirectoryKind, Scope } from '#lib/admin/types.ts';
	import SegmentedLinks, { type SegmentedLink } from '../SegmentedLinks.svelte';
	import ConversationList from './ConversationList.svelte';

	interface Props {
		frame: AdminFrame;
		scope: Scope;
		scopeLinks: SegmentedLink[];
		showsScopeSwitch: boolean;
		query: string;
		selectedConversation?: string;
		directoryKind?: DirectoryKind;
		class?: string;
	}

	let { frame, scope, scopeLinks, showsScopeSwitch, query, selectedConversation, directoryKind, class: className = '' }: Props = $props();
</script>

<aside data-workspace-sidebar class={['flex min-h-0 min-w-0 flex-col bg-sidebar', className]} aria-label="Workspace conversations">
	<div class="flex flex-col gap-2 border-b border-secondary p-3 pb-2.5 max-[899px]:px-4">
		<form action="/search" method="get" role="search" class="search-form relative">
			<input type="hidden" name="scope" value={scope} />
			<span aria-hidden="true" class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-dim">/</span>
			<Input type="search" name="q" value={query} aria-label="Search conversations" aria-keyshortcuts="/" placeholder="Search conversations" class="h-8 bg-ground pl-6 font-mono text-[13px]" />
		</form>
		{#if showsScopeSwitch}<SegmentedLinks links={scopeLinks} label="Whose agents to show" class="flex w-full" />{/if}
	</div>
	<ConversationList groups={frame.sidebarGroups} nowMs={frame.nowMs} {scope} viewerEmail={frame.viewer.email} {selectedConversation} {directoryKind} />
</aside>
