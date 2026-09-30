import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { buildSidebarGroups, deployedVersion, loginHref, sidebarKindsFor, sidebarSortFor } from './helpers';
import type { AdminApiRpc, AdminResult, AdminSession, Conversation, DirectoryKind, Scope, Viewer } from './types';

export type AdminFailure = Extract<AdminResult<unknown>, { ok: false }>['error'];
export interface AdminApi {
	viewer(): ReturnType<AdminApiRpc['viewer']>;
	serverVersion(): ReturnType<AdminApiRpc['serverVersion']>;
	listConversations(options: Parameters<AdminApiRpc['listConversations']>[1]): ReturnType<AdminApiRpc['listConversations']>;
	readConversation(options: Parameters<AdminApiRpc['readConversation']>[1]): ReturnType<AdminApiRpc['readConversation']>;
	markRead(options: Parameters<AdminApiRpc['markRead']>[1]): ReturnType<AdminApiRpc['markRead']>;
	listPins(options: Parameters<AdminApiRpc['listPins']>[1]): ReturnType<AdminApiRpc['listPins']>;
	downloadFile(options: Parameters<AdminApiRpc['downloadFile']>[1]): ReturnType<AdminApiRpc['downloadFile']>;
	search(options: Parameters<AdminApiRpc['search']>[1]): ReturnType<AdminApiRpc['search']>;
	listInstallations(): ReturnType<AdminApiRpc['listInstallations']>;
	revokeInstallation(options: Parameters<AdminApiRpc['revokeInstallation']>[1]): ReturnType<AdminApiRpc['revokeInstallation']>;
	listHeadlessKeys(options: Parameters<AdminApiRpc['listHeadlessKeys']>[1]): ReturnType<AdminApiRpc['listHeadlessKeys']>;
	createHeadlessKey(options: Parameters<AdminApiRpc['createHeadlessKey']>[1]): ReturnType<AdminApiRpc['createHeadlessKey']>;
	rotateHeadlessKey(options: Parameters<AdminApiRpc['rotateHeadlessKey']>[1]): ReturnType<AdminApiRpc['rotateHeadlessKey']>;
	revokeHeadlessKey(options: Parameters<AdminApiRpc['revokeHeadlessKey']>[1]): ReturnType<AdminApiRpc['revokeHeadlessKey']>;
	revokeHeadlessAgent(options: Parameters<AdminApiRpc['revokeHeadlessAgent']>[1]): ReturnType<AdminApiRpc['revokeHeadlessAgent']>;
	listOwnAgents(): ReturnType<AdminApiRpc['listOwnAgents']>;
	revokeOwnAgent(options: Parameters<AdminApiRpc['revokeOwnAgent']>[1]): ReturnType<AdminApiRpc['revokeOwnAgent']>;
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

export type ErrorStatus = 400 | 404 | 500;
export interface ErrorView {
	status: ErrorStatus;
}

const rewritableMethods = new Set(['GET', 'HEAD']);

export async function failureResponse(context: APIContext, failure: AdminFailure): Promise<Response> {
	if (failure === 'unauthorized') return signInRedirect(context);
	if (failure === 'not_found') return new Response(null, { status: 404 });
	const errorView: ErrorView = { status: 400 };
	if (!rewritableMethods.has(context.request.method)) return new Response(null, { status: errorView.status });
	context.locals.errorView = errorView;
	const errorPage = await context.rewrite(`/404${context.url.search}`);
	return new Response(errorPage.body, { status: errorView.status, headers: errorPage.headers });
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
		serverVersion: () => rpc.serverVersion(accessToken),
		listConversations: (options) => rpc.listConversations(accessToken, options),
		readConversation: (options) => rpc.readConversation(accessToken, options),
		markRead: (options) => rpc.markRead(accessToken, options),
		listPins: (options) => rpc.listPins(accessToken, options),
		downloadFile: (options) => rpc.downloadFile(accessToken, options),
		search: (options) => rpc.search(accessToken, options),
		listInstallations: () => rpc.listInstallations(accessToken),
		revokeInstallation: (options) => rpc.revokeInstallation(accessToken, options),
		listHeadlessKeys: (options) => rpc.listHeadlessKeys(accessToken, options),
		createHeadlessKey: (options) => rpc.createHeadlessKey(accessToken, options),
		rotateHeadlessKey: (options) => rpc.rotateHeadlessKey(accessToken, options),
		revokeHeadlessKey: (options) => rpc.revokeHeadlessKey(accessToken, options),
		revokeHeadlessAgent: (options) => rpc.revokeHeadlessAgent(accessToken, options),
		listOwnAgents: () => rpc.listOwnAgents(accessToken),
		revokeOwnAgent: (options) => rpc.revokeOwnAgent(accessToken, options),
	};
}

async function mcpVersionOrUnknown(adminApi: AdminApi): Promise<string> {
	const serverVersion = await adminApi.serverVersion().catch((error: unknown) => {
		console.error('admin serverVersion lookup failed', error);
		return undefined;
	});
	if (!serverVersion?.ok) return 'unknown';
	return serverVersion.value;
}

export async function loadAdminFrame(context: APIContext, scope: Scope) {
	const adminApi = await adminApiFor(context);
	if (adminApi instanceof Response) return adminApi;
	const listSidebarKind = (kind: DirectoryKind) => adminApi.listConversations({ scope, kind, sort: sidebarSortFor(kind, scope) });
	const showsPrivateChats = sidebarKindsFor(scope).includes('private');
	const [viewer, mcpVersion, publicListing, privateListing] = await Promise.all([
		adminApi.viewer(),
		mcpVersionOrUnknown(adminApi),
		listSidebarKind('public'),
		showsPrivateChats ? listSidebarKind('private') : undefined,
	]);
	if (!viewer.ok) return failureResponse(context, viewer.error);
	if (!publicListing.ok) return failureResponse(context, publicListing.error);
	if (privateListing && !privateListing.ok) return failureResponse(context, privateListing.error);
	const nowMs = Date.now();
	const conversationsByKind: Record<DirectoryKind, Conversation[]> = {
		public: publicListing.value.conversations,
		private: privateListing?.value.conversations ?? [],
	};
	const frame: AdminFrame = {
		viewer: viewer.value,
		versions: { web: deployedVersion(env.CF_VERSION_METADATA), mcp: mcpVersion },
		nowMs,
		sidebarGroups: buildSidebarGroups(conversationsByKind, publicListing.value.totals, scope, nowMs),
	};
	context.locals.adminFrame = frame;
	return { adminApi, frame };
}

export interface AdminFrame {
	viewer: Viewer;
	versions: { web: string; mcp: string };
	nowMs: number;
	sidebarGroups: ReturnType<typeof buildSidebarGroups>;
}
