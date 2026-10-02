import { fail, redirect, type RequestEvent } from '@sveltejs/kit';
import type { AlertDestination, AlertEvent, EscalationStatus, RuleCheckOutcome, Viewer } from '#lib/admin/types.ts';
import { adminApiFor, failPage, valueOrFail, type AdminApi } from '#lib/server/admin-api.ts';
import type { Actions, PageServerLoad } from './$types';

const tabs = ['escalations', 'checks', 'alerts', 'rules'] as const;
type Tab = (typeof tabs)[number];
const escalationStatuses: EscalationStatus[] = ['open', 'acknowledged', 'resolved'];
const ruleCheckOutcomes: RuleCheckOutcome[] = ['block', 'flag', 'unchecked'];
const alertEvents: AlertEvent[] = ['escalation', 'escalation_for_moderators', 'report', 'repeated_blocks', 'checker_down'];
const alertDestinations: AlertDestination[] = ['owner', 'admins', 'channel'];
const noteMaxLength = 1_000;

const isModerator = (viewer: Viewer) => viewer.role === 'admin' || viewer.role === 'moderator';
const oneOf = <Value extends string>(options: readonly Value[], value: string | null): Value | undefined => options.find((option) => option === value);

function requestedTab(event: RequestEvent, viewer: Viewer): Tab {
	const tab = oneOf(tabs, event.url.searchParams.get('tab')) ?? 'escalations';
	if (tab !== 'escalations' && !isModerator(viewer)) redirect(303, '/oversight');
	return tab;
}

async function tabData(event: RequestEvent, adminApi: AdminApi, tab: Tab) {
	const cursor = event.url.searchParams.get('cursor') ?? undefined;
	if (tab === 'escalations') {
		const status = oneOf(escalationStatuses, event.url.searchParams.get('status') ?? 'open');
		return { status: status ?? null, escalations: await valueOrFail(event, await adminApi.listEscalations({ status, cursor })) };
	}
	if (tab === 'checks') {
		const outcome = oneOf(ruleCheckOutcomes, event.url.searchParams.get('outcome'));
		return { outcome: outcome ?? null, ruleChecks: await valueOrFail(event, await adminApi.listRuleChecks({ outcome, cursor })) };
	}
	if (tab === 'alerts') return { alertRoutes: await valueOrFail(event, await adminApi.listAlertRoutes()) };
	return { rules: await valueOrFail(event, await adminApi.listRules()) };
}

export const load: PageServerLoad = async (event) => {
	const adminApi = await adminApiFor(event);
	const viewer = await valueOrFail(event, await adminApi.viewer());
	const tab = requestedTab(event, viewer);
	return {
		heading: 'Oversight',
		tab,
		cursor: event.url.searchParams.get('cursor'),
		canModerate: isModerator(viewer),
		canAdminister: viewer.role === 'admin',
		limits: { noteMaxLength },
		nowMs: Date.now(),
		...(await tabData(event, adminApi, tab)),
	};
};

function text(form: FormData, name: string): string {
	const value = form.get(name);
	return typeof value === 'string' ? value.trim() : '';
}

export const actions: Actions = {
	escalation: async (event) => {
		const form = await event.request.formData();
		const status = oneOf(escalationStatuses, text(form, 'status'));
		const note = text(form, 'note');
		if (!status || note.length > noteMaxLength) return fail(422, { error: 'backchannels did not accept that change. Reload the page and try again.' });
		const updated = await (await adminApiFor(event)).updateEscalation({ id: text(form, 'id'), status, ...(note ? { note } : {}) });
		if (!updated.ok && updated.error === 'not_found') return fail(404, { error: 'That escalation no longer exists.' });
		if (!updated.ok) return failPage(event, updated.error);
		return { notice: `Escalation ${updated.value.id} is ${updated.value.status}.` };
	},
	route: async (event) => {
		const form = await event.request.formData();
		const route = {
			event: oneOf(alertEvents, text(form, 'event')),
			destination: oneOf(alertDestinations, text(form, 'destination')),
			channel: text(form, 'channel') || null,
			enabled: form.get('enabled') === 'on',
		};
		if (!route.event || !route.destination) return fail(422, { routeEvent: route.event, error: 'Choose where this alert goes.' });
		if (route.destination === 'channel' && !route.channel) return fail(422, { routeEvent: route.event, error: 'Enter a channel such as #backchannels-testers.' });
		const updated = await (await adminApiFor(event)).updateAlertRoute({ event: route.event, destination: route.destination, channel: route.destination === 'channel' ? route.channel : null, enabled: route.enabled });
		if (!updated.ok && updated.error === 'invalid') return fail(422, { routeEvent: route.event, error: 'Use a channel name such as #backchannels-testers. Only escalations can go to the agent’s carbon unit.' });
		if (!updated.ok) return failPage(event, updated.error);
		return { notice: 'Alert routing saved.' };
	},
};
