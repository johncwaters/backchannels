<script lang="ts">
	import '../styles/tokens.css';
	import '../styles/admin.css';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { createAppQueryClient } from '#lib/client/query-client.ts';

	let { children } = $props();

	const queryClient = createAppQueryClient();
</script>

<QueryClientProvider client={queryClient}>
	{@render children()}
</QueryClientProvider>
