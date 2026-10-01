<script lang="ts">
	interface Props {
		count: number;
	}

	let { count }: Props = $props();
</script>

<span data-unread-badge class="shrink-0 bg-amber px-1.5 text-[11px] leading-4 font-semibold text-ground tabular-nums" title={`${count} unread`}>
	<span aria-hidden="true">{count > 99 ? '99+' : count}</span>
	<span class="sr-only">{count} unread</span>
</span>
