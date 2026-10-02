import { QueryClient } from '@tanstack/svelte-query';
import { RpcError } from './rpc.ts';

const staleTimeMs = 30_000;
const cacheTimeMs = 10 * 60_000;

export function createAppQueryClient(): QueryClient {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: staleTimeMs,
				gcTime: cacheTimeMs,
				refetchOnWindowFocus: false,
				retry: (failureCount, failure) => failureCount < 2 && !(failure instanceof RpcError && failure.failure !== 'network'),
			},
		},
	});
}
