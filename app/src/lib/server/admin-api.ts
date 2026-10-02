import { error, redirect, type RequestEvent } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { buildSidebarGroups, deployedVersion, loginHref, sidebarKindsFor, sidebarSortFor } from '#lib/admin/helpers.ts';
import type { AdminApiRpc, AdminResult, AdminSession, Conversation, DirectoryKind, Scope } from '#lib/admin/types.ts';
import type { AdminFrame } from '#lib/admin/frame.ts';

export type AdminFailure = Extract<AdminResult<unknown>, { ok: false }>['error'];
type TokenlessMethods = 'adminSignInUrl' | 'exchangeAdminCode' | 'refreshAdminSession' | 'revokeAdminSession';
type DropToken<Method> = Method extends (token: string, ...rest: infer Rest) => infer Result ? (...rest: Rest) => Result : never;
export type AdminApi = { [Name in Exclude<keyof AdminApiRpc, TokenlessMethods>]: DropToken<AdminApiRpc[Name]> };

const refreshWindowMs = 60_000;
const tokenMethods = [
	'viewer',
	'serverVersion',
	'changeToken',
	'listConversations',
	'readConversation',
	'markRead',
	'listPins',
	'downloadFile',
	'search',
	'listInstallations',
	'revokeInstallation',
	'listHeadlessKeys',
	'createHeadlessKey',
	'rotateHeadlessKey',
	'revokeHeadlessKey',
	'revokeHeadlessAgent',
	'listOwnAgents',
	'revokeOwnAgent',
] as const satisfies readonly (keyof AdminApi)[];

// Each call goes through an async function, so it returns a real Promise. The local platform proxy
// returns RPC thenables without catch or finally.
const rpcStub = new Proxy({} as AdminApiRpc, {
	get: (_target, name: string) =>
		name === 'then'
			? undefined
			: async (...input: unknown[]) => (env.ADMIN_API as unknown as Record<string, (...rest: unknown[]) => unknown>)[name](...input),
});

export function adminRpc(): AdminApiRpc {
	return rpcStub;
}

export function adminRedirectUri(url: URL): string {
	return new URL('/callback', url.origin).href;
}

// Ends this browser's session and sends the carbon unit through sign-in again.
export async function signInRedirect(event: RequestEvent): Promise<never> {
	await event.locals.session.destroy();
	redirect(302, loginHref(event.url));
}

// Turns an api rejection into the response a page load gives: sign-in for a dead grant,
// 404 for something the carbon unit cannot see, and 400 for a request the api did not accept.
export async function failPage(event: RequestEvent, failure: AdminFailure): Promise<never> {
	if (failure === 'unauthorized') return signInRedirect(event);
	if (failure === 'not_found') error(404, 'Page not found');
	error(400, 'Link not understood');
}

// The same rejection for a JSON endpoint, which a script calls and cannot follow to sign-in.
export async function failEndpoint(event: RequestEvent, failure: AdminFailure): Promise<never> {
	if (failure === 'unauthorized') {
		await event.locals.session.destroy();
		error(401, 'Sign in again');
	}
	if (failure === 'not_found') error(404, 'Not found');
	error(400, 'Request not accepted');
}

export async function valueOrFail<Value>(event: RequestEvent, result: AdminResult<Value>): Promise<Value> {
	if (!result.ok) return failPage(event, result.error);
	return result.value;
}

async function freshAdminSession(event: RequestEvent): Promise<AdminSession | null> {
	const storedSession = event.locals.session.get('adminSession');
	if (!storedSession) return null;
	if (storedSession.expiresAt - Date.now() > refreshWindowMs) return storedSession;
	const refreshed = await adminRpc().refreshAdminSession({ refreshToken: storedSession.refreshToken, redirectUri: adminRedirectUri(event.url) });
	if (!refreshed.ok) return null;
	await event.locals.session.set('adminSession', refreshed.value);
	return refreshed.value;
}

function boundTo(accessToken: string): AdminApi {
	const rpc = adminRpc() as unknown as Record<string, (token: string, ...rest: unknown[]) => unknown>;
	return Object.fromEntries(tokenMethods.map((name) => [name, (...rest: unknown[]) => rpc[name](accessToken, ...rest)])) as unknown as AdminApi;
}

// The layout and page loads of one request run in parallel, so they share one refresh:
// a refresh token used twice could end the grant.
function sessionForRequest(event: RequestEvent): Promise<AdminSession | null> {
	event.locals.adminSession ??= freshAdminSession(event);
	return event.locals.adminSession;
}

export async function adminApiFor(event: RequestEvent): Promise<AdminApi> {
	const adminSession = await sessionForRequest(event);
	if (!adminSession) return signInRedirect(event);
	return boundTo(adminSession.accessToken);
}

export async function endpointAdminApiFor(event: RequestEvent): Promise<AdminApi> {
	const adminSession = await sessionForRequest(event);
	if (!adminSession) return failEndpoint(event, 'unauthorized');
	return boundTo(adminSession.accessToken);
}

async function mcpVersionOrUnknown(adminApi: AdminApi): Promise<string> {
	const serverVersion = await adminApi.serverVersion().catch((failure: unknown) => {
		console.error('admin serverVersion lookup failed', failure);
		return undefined;
	});
	if (!serverVersion?.ok) return 'unknown';
	return serverVersion.value;
}

export async function loadAdminFrame(event: RequestEvent, adminApi: AdminApi, scope: Scope): Promise<AdminFrame> {
	const changeToken = await valueOrFail(event, await adminApi.changeToken());
	const listSidebarKind = (kind: DirectoryKind) => adminApi.listConversations({ scope, kind, sort: sidebarSortFor(kind, scope) });
	const showsPrivateChats = sidebarKindsFor(scope).includes('private');
	const [viewer, mcpVersion, publicListing, privateListing] = await Promise.all([
		adminApi.viewer(),
		mcpVersionOrUnknown(adminApi),
		listSidebarKind('public'),
		showsPrivateChats ? listSidebarKind('private') : undefined,
	]);
	const viewerValue = await valueOrFail(event, viewer);
	const publicValue = await valueOrFail(event, publicListing);
	const privateValue = privateListing ? await valueOrFail(event, privateListing) : undefined;
	const nowMs = Date.now();
	const conversationsByKind: Record<DirectoryKind, Conversation[]> = {
		public: publicValue.conversations,
		private: privateValue?.conversations ?? [],
	};
	return {
		viewer: viewerValue,
		changeToken,
		versions: { web: deployedVersion(env.CF_VERSION_METADATA), mcp: mcpVersion },
		nowMs,
		scope,
		sidebarGroups: buildSidebarGroups(conversationsByKind, publicValue.totals, scope, nowMs),
	};
}
