import { loginHref } from '#lib/admin/helpers.ts';
import type { AdminFrame } from '#lib/admin/frame.ts';
import type { AdminApiRpc, AdminResult, Scope } from '#lib/admin/types.ts';

type SessionlessMethod = 'adminSignInUrl' | 'exchangeAdminCode' | 'refreshAdminSession' | 'revokeAdminSession' | 'downloadFile';
export type RpcMethod = Exclude<keyof AdminApiRpc, SessionlessMethod>;
export type RpcArgs<Method extends RpcMethod> = AdminApiRpc[Method] extends (token: string, ...rest: infer Rest) => unknown ? Rest : never;
export type RpcValue<Method extends RpcMethod> = Awaited<ReturnType<AdminApiRpc[Method]>> extends AdminResult<infer Value> ? Value : never;
export type RpcFailure = Extract<AdminResult<unknown>, { ok: false }>['error'];

export class RpcError extends Error {
	readonly failure: RpcFailure | 'network';

	constructor(failure: RpcFailure | 'network') {
		super(failure);
		this.failure = failure;
	}
}

async function postJson(path: string, body: unknown): Promise<Response> {
	return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
}

async function readBody<Value>(response: Response): Promise<Value> {
	if (response.status === 401) {
		location.assign(loginHref(new URL(location.href)));
		throw new RpcError('unauthorized');
	}
	if (!response.ok) throw new RpcError(response.status === 404 ? 'not_found' : 'network');
	return response.json() as Promise<Value>;
}

export async function rpc<Method extends RpcMethod>(method: Method, ...args: RpcArgs<Method>): Promise<RpcValue<Method>> {
	const response = await postJson(`/rpc/${method}`, { args }).catch(() => {
		throw new RpcError('network');
	});
	const result = await readBody<AdminResult<RpcValue<Method>>>(response);
	if (!result.ok) throw new RpcError(result.error);
	return result.value;
}

export function rpcQuery<Method extends RpcMethod>(method: Method, ...args: RpcArgs<Method>) {
	return { queryKey: [method, ...args] as const, queryFn: () => rpc(method, ...args) };
}

export function frameQuery(scope: Scope) {
	return {
		queryKey: ['frame', scope] as const,
		queryFn: async () => readBody<AdminFrame>(await fetch(`/frame?scope=${scope}`, { headers: { accept: 'application/json' } })),
	};
}
