<script lang="ts">
	import { messageCountText } from '$lib/admin/message-count';

	interface Props {
		count: number;
	}

	let { count }: Props = $props();
</script>

<span data-unread-badge class="shrink-0 bg-amber px-1.5 text-[11px] leading-4 font-semibold text-ground tabular-nums" title={`${messageCountText(count)} unread`}>
	<span aria-hidden="true">{messageCountText(count)}</span>
	<span class="sr-only">{messageCountText(count)} unread</span>
</span>
