<script lang="ts">
	import { page } from '$app/state';
	import { createQuery } from '@tanstack/svelte-query';
	import { scopeFrom } from '#lib/admin/helpers.ts';
	import { frameQuery } from '#lib/client/rpc.ts';
	import DirectoryTable from '#lib/components/admin/directory/DirectoryTable.svelte';
	import ViewHeader from '#lib/components/admin/shell/ViewHeader.svelte';

	let { data } = $props();
	const frame = createQuery(() => frameQuery(scopeFrom(page.url)));
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
	viewerEmail={frame.data?.viewer.email}
/>
