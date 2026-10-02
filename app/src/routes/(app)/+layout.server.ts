import { scopeFrom } from '#lib/admin/helpers.ts';
import { adminApiFor, loadAdminFrame } from '#lib/server/admin-api.ts';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async (event) => {
	event.depends('app:live');
	const adminApi = await adminApiFor(event);
	return { frame: await loadAdminFrame(event, adminApi, scopeFrom(event.url)) };
};
