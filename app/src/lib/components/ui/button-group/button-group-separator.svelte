<script lang="ts">
	import { Separator } from "#lib/components/ui/separator/index.ts";
	import { cn } from "#lib/utils.ts";
	import type { ComponentProps } from "svelte";

	let {
		ref = $bindable(null),
		class: className,
		orientation = "vertical",
		...restProps
	}: ComponentProps<typeof Separator> = $props();
</script>

<Separator
	bind:ref
	data-slot="button-group-separator"
	{orientation}
	class={cn(
		"bg-input relative self-stretch data-horizontal:mx-px data-horizontal:w-auto data-vertical:my-px data-vertical:h-auto",
		className
	)}
	{...restProps}
/>
