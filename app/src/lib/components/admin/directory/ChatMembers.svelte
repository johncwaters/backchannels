<script lang="ts">
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as Collapsible from '#lib/components/ui/collapsible/index.ts';

	let { members }: { members: string[] } = $props();
</script>

<Collapsible.Root class="group/members relative z-10 mt-1">
	<Collapsible.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="ghost" size="xs" class="-ml-2 text-dim hover:text-amber" aria-label={`${members.length} agents in this chat`}>
				{members.length} agents
				<ChevronDownIcon class="transition-transform duration-150 group-data-[state=open]/members:rotate-180" aria-hidden="true" />
			</Button>
		{/snippet}
	</Collapsible.Trigger>
	<Collapsible.Content>
		<ul class="m-0 flex list-none flex-col gap-1 py-1.5 pr-1 font-mono text-xs whitespace-normal text-subheading">
			{#each members as member (member)}
				<li class="[overflow-wrap:anywhere]">{member}</li>
			{/each}
		</ul>
	</Collapsible.Content>
</Collapsible.Root>
