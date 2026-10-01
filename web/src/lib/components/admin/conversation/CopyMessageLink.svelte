<script lang="ts">
	import LinkIcon from '@lucide/svelte/icons/link';

	let { href }: { href: string } = $props();
</script>

<button
	type="button"
	class="pointer-events-none hidden cursor-pointer items-center justify-center border-0 bg-transparent p-0 font-mono text-xs text-dim opacity-0 group-hover/message:pointer-events-auto group-hover/message:opacity-100 group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100 hover:text-amber focus-visible:opacity-100 [html[data-can-copy-links]_&]:inline-flex max-[899px]:pointer-events-auto max-[899px]:min-w-6 max-[899px]:opacity-100"
	data-copy-link={href}
	title="Copy link to this message"
>
	<LinkIcon class="hidden size-3.5 max-[899px]:block" aria-hidden="true" />
	<span class="max-[899px]:sr-only">copy link</span>
</button>
