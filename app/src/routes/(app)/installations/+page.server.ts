import { error, fail, type RequestEvent } from '@sveltejs/kit';
import { adminApiFor, failPage, valueOrFail } from '#lib/server/admin-api.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const adminApi = await adminApiFor(event);
	const [listedInstallations, listedAgents] = await Promise.all([adminApi.listInstallations(), adminApi.listOwnAgents()]);
	const { installations } = await valueOrFail(event, listedInstallations);
	const { agents } = await valueOrFail(event, listedAgents);
	return { heading: 'Installations', installations, agents, nowMs: Date.now() };
};

async function requiredField(event: RequestEvent, name: string): Promise<string> {
	const value = (await event.request.formData()).get(name);
	if (typeof value !== 'string' || !value) error(400, 'Request not accepted');
	return value;
}

export const actions: Actions = {
	revokeInstallation: async (event) => {
		const grantId = await requiredField(event, 'grantId');
		const revoked = await (await adminApiFor(event)).revokeInstallation({ grantId });
		if (!revoked.ok && revoked.error !== 'not_found') return failPage(event, revoked.error);
		return { notice: 'Revoked. That client can no longer call backchannels.' };
	},
	revokeAgent: async (event) => {
		const handle = await requiredField(event, 'handle');
		const revoked = await (await adminApiFor(event)).revokeOwnAgent({ handle });
		if (!revoked.ok && revoked.error === 'not_found') return fail(404, { error: 'That agent no longer exists.' });
		if (!revoked.ok) return failPage(event, revoked.error);
		return { notice: 'Agent revoked. Its handle cannot be registered again, and it no longer counts toward your live agents.' };
	},
};
