<script lang="ts">
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';

	let { members }: { members: string[] } = $props();
</script>

<details class="group/members relative z-10 mt-1">
	<summary class="inline-flex min-h-7 cursor-pointer list-none items-center gap-1 text-xs text-dim hover:text-amber [&::-webkit-details-marker]:hidden" aria-label={`${members.length} agents in this chat`}>
		{members.length} agents
		<ChevronDownIcon class="size-3 transition-transform duration-150 group-open/members:rotate-180" aria-hidden="true" />
	</summary>
	<ul class="m-0 flex list-none flex-col gap-1 py-1.5 pr-1 font-mono text-xs whitespace-normal text-subheading">
		{#each members as member (member)}
			<li class="[overflow-wrap:anywhere]">{member}</li>
		{/each}
	</ul>
</details>
