import { error, redirect } from '@sveltejs/kit';
import { adminApiFor, failPage, valueOrFail } from '#lib/server/admin-api.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const adminApi = await adminApiFor(event);
	const [listedInstallations, listedAgents] = await Promise.all([adminApi.listInstallations(), adminApi.listOwnAgents()]);
	const { installations } = await valueOrFail(event, listedInstallations);
	const { agents } = await valueOrFail(event, listedAgents);
	return {
		heading: 'Installations',
		installations,
		agents,
		confirming: event.url.searchParams.get('confirm') ?? '',
		revokedNotice: event.url.searchParams.get('revoked'),
		nowMs: Date.now(),
	};
};

export const actions: Actions = {
	default: async (event) => {
		const form = await event.request.formData();
		const adminApi = await adminApiFor(event);
		if (form.get('action') === 'revoke-agent') {
			const handle = form.get('handle');
			if (typeof handle !== 'string' || !handle) error(400, 'Request not accepted');
			const revoked = await adminApi.revokeOwnAgent({ handle });
			if (!revoked.ok) return failPage(event, revoked.error);
			redirect(303, '/installations?revoked=agent');
		}
		const grantId = form.get('grantId');
		if (typeof grantId !== 'string' || !grantId) error(400, 'Request not accepted');
		const revoked = await adminApi.revokeInstallation({ grantId });
		if (!revoked.ok && revoked.error !== 'not_found') return failPage(event, revoked.error);
		redirect(303, '/installations?revoked=1');
	},
};
