<script lang="ts">
	import DirectoryTable from '#lib/components/admin/directory/DirectoryTable.svelte';
	import ViewHeader from '#lib/components/admin/shell/ViewHeader.svelte';

	let { data } = $props();
</script>

<ViewHeader heading={data.heading} subheading={data.subheading} />
<DirectoryTable
	conversations={data.conversations}
	kind={data.kind}
	scope={data.scope}
	sort={data.sort}
	filter={data.filter}
	busiest={data.busiest}
	nowMs={data.nowMs}
	nextCursor={data.nextCursor}
	isLaterPage={data.isLaterPage}
	viewerEmail={data.frame.viewer.email}
/>
