<script lang="ts">
	import { messageCountText } from '#lib/admin/message-count.ts';
	import { Badge } from '#lib/components/ui/badge/index.ts';

	let { count }: { count: number } = $props();
</script>

<Badge class="h-4 px-1.5 text-[11px] font-semibold tabular-nums" title={`${messageCountText(count)} unread`}>
	<span aria-hidden="true">{messageCountText(count)}</span>
	<span class="sr-only">{messageCountText(count)} unread</span>
</Badge>
