import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { buildSidebarGroups, loginHref, sidebarSortFor } from './helpers';
import type { AdminApiRpc, AdminResult, AdminSession, Conversation, DirectoryKind, Scope } from './types';

type AdminFailure = Extract<AdminResult<unknown>, { ok: false }>['error'];
export interface AdminApi {
	viewer(): ReturnType<AdminApiRpc['viewer']>;
	listConversations(options: Parameters<AdminApiRpc['listConversations']>[1]): ReturnType<AdminApiRpc['listConversations']>;
	readConversation(options: Parameters<AdminApiRpc['readConversation']>[1]): ReturnType<AdminApiRpc['readConversation']>;
	search(options: Parameters<AdminApiRpc['search']>[1]): ReturnType<AdminApiRpc['search']>;
	listInstallations(): ReturnType<AdminApiRpc['listInstallations']>;
	revokeInstallation(options: Parameters<AdminApiRpc['revokeInstallation']>[1]): ReturnType<AdminApiRpc['revokeInstallation']>;
}

const refreshWindowMs = 60_000;

export function adminRpc(): AdminApiRpc {
	return env.ADMIN_API as unknown as AdminApiRpc;
}

export function adminRedirectUri(url: URL): string {
	return new URL('/admin/callback', url.origin).href;
}

export function signInRedirect(context: APIContext): Response {
	context.session?.destroy();
	return context.redirect(loginHref(context.url), 302);
}

export function failureResponse(context: APIContext, failure: AdminFailure): Response {
	if (failure === 'unauthorized') return signInRedirect(context);
	return new Response(null, { status: failure === 'not_found' ? 404 : 400 });
}

async function freshAdminSession(context: APIContext): Promise<AdminSession | null> {
	const storedSession = await context.session?.get('adminSession');
	if (!storedSession) return null;
	if (storedSession.expiresAt - Date.now() > refreshWindowMs) return storedSession;
	const refreshed = await adminRpc().refreshAdminSession({
		refreshToken: storedSession.refreshToken,
		redirectUri: adminRedirectUri(context.url),
	});
	if (!refreshed.ok) return null;
	context.session?.set('adminSession', refreshed.value);
	return refreshed.value;
}

export async function adminApiFor(context: APIContext): Promise<AdminApi | Response> {
	const adminSession = await freshAdminSession(context);
	if (!adminSession) return signInRedirect(context);
	const rpc = adminRpc();
	const { accessToken } = adminSession;
	return {
		viewer: () => rpc.viewer(accessToken),
		listConversations: (options) => rpc.listConversations(accessToken, options),
		readConversation: (options) => rpc.readConversation(accessToken, options),
		search: (options) => rpc.search(accessToken, options),
		listInstallations: () => rpc.listInstallations(accessToken),
		revokeInstallation: (options) => rpc.revokeInstallation(accessToken, options),
	};
}

export async function loadAdminFrame(context: APIContext, scope: Scope) {
	const adminApi = await adminApiFor(context);
	if (adminApi instanceof Response) return adminApi;
	const listSidebarKind = (kind: DirectoryKind) => adminApi.listConversations({ scope, kind, sort: sidebarSortFor(kind, scope) });
	const [viewer, publicListing, privateListing] = await Promise.all([
		adminApi.viewer(),
		listSidebarKind('public'),
		listSidebarKind('private'),
	]);
	if (!viewer.ok) return failureResponse(context, viewer.error);
	if (!publicListing.ok) return failureResponse(context, publicListing.error);
	if (!privateListing.ok) return failureResponse(context, privateListing.error);
	const nowMs = Date.now();
	const conversationsByKind: Record<DirectoryKind, Conversation[]> = {
		public: publicListing.value.conversations,
		private: privateListing.value.conversations,
	};
	return {
		adminApi,
		frame: {
			viewer: viewer.value,
			nowMs,
			sidebarGroups: buildSidebarGroups(conversationsByKind, publicListing.value.totals, scope, nowMs),
		},
	};
}

export type AdminFrame = Exclude<Awaited<ReturnType<typeof loadAdminFrame>>, Response>['frame'];
