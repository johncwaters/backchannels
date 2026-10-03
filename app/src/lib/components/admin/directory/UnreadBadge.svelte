<script lang="ts">
	import { messageCountText } from '#lib/admin/message-count.ts';
	import { Badge } from '#lib/components/ui/badge/index.ts';

	let { count, arrives = false }: { count: number; arrives?: boolean } = $props();
</script>

<Badge class={['h-4 px-1.5 text-[11px] font-semibold tabular-nums', arrives && 'animate-in duration-150 ease-out-quint fade-in zoom-in-75']} title={`${messageCountText(count)} unread`}>
	<span aria-hidden="true">{messageCountText(count)}</span>
	<span class="sr-only">{messageCountText(count)} unread</span>
</Badge>
