import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import type { AdminResult, NewHeadlessKey } from '#lib/admin/types.ts';
import { agentsHref } from '#lib/components/admin/settings/agents-href.ts';
import { adminApiFor, failPage, valueOrFail, type AdminApi, type AdminFailure } from '#lib/server/admin-api.ts';
import type { Actions, PageServerLoad } from './$types';

type CreateField = 'label' | 'suggestedName' | 'expiresInDays';
type CreateValues = Record<CreateField, string>;

const labelMaxLength = 80;
const agentNameMaxLength = 40;
const maxExpiryDays = 90;
const agentNamePattern = /^[a-z0-9][a-z0-9_-]*$/;

const errorMessages: Partial<Record<AdminFailure, string>> = {
	invalid: 'backchannels did not accept that request. Reload the page and try again.',
	already_rotated: 'That key was already rotated. Rotate its replacement instead.',
	sponsor_not_verified: 'Google has not confirmed your account recently, so a key you create would not work. Sign out and sign in again, then retry.',
	not_found: 'That key or agent no longer exists.',
};
const doneMessages: Record<string, string> = {
	'revoked-key': 'Key revoked. Agents that used it get 401 on their next call.',
	'revoked-agent': 'Agent revoked. Its handle cannot be registered again.',
};

function normalizedAgentName(input: string): string {
	return input.trim().replace(/^@/, '').replace(/^[^/]*\//, '');
}

function createFieldErrors(values: CreateValues): Partial<Record<CreateField, string>> {
	const errors: Partial<Record<CreateField, string>> = {};
	if (!values.label) errors.label = 'Enter a label.';
	else if (values.label.length > labelMaxLength) errors.label = `Use ${labelMaxLength} characters or fewer.`;
	if (!values.suggestedName) errors.suggestedName = 'Enter an agent name.';
	else if (values.suggestedName.length > agentNameMaxLength) errors.suggestedName = `Use ${agentNameMaxLength} characters or fewer.`;
	else if (!agentNamePattern.test(values.suggestedName)) errors.suggestedName = 'Use lowercase a-z, 0-9, - and _, and start with a letter or digit.';
	const days = Number(values.expiresInDays);
	if (!Number.isInteger(days) || days < 1 || days > maxExpiryDays) errors.expiresInDays = `Enter a whole number from 1 to ${maxExpiryDays}.`;
	return errors;
}

// Only workspace admins see this page. The api answers others with unauthorized, which would end their session.
async function adminOnlyApi(event: RequestEvent): Promise<AdminApi> {
	const adminApi = await adminApiFor(event);
	const viewer = await valueOrFail(event, await adminApi.viewer());
	if (!viewer.isAdmin) error(404, 'Page not found');
	return adminApi;
}

async function redirectWithError(event: RequestEvent, failure: AdminFailure, cursor: string): Promise<never> {
	if (failure === 'unauthorized') return failPage(event, failure);
	redirect(303, agentsHref({ error: failure }, cursor));
}

async function flashNewKey(event: RequestEvent, result: AdminResult<NewHeadlessKey>, cursor: string, wasRotated: boolean): Promise<never> {
	if (!result.ok) return redirectWithError(event, result.error, cursor);
	await event.locals.session.set('newHeadlessKey', { ...result.value, wasRotated });
	redirect(303, agentsHref({}, cursor));
}

async function redirectAfter(event: RequestEvent, result: AdminResult<null>, done: string, cursor: string): Promise<never> {
	if (!result.ok) return redirectWithError(event, result.error, cursor);
	redirect(303, agentsHref({ done }, cursor));
}

export const load: PageServerLoad = async (event) => {
	const adminApi = await adminOnlyApi(event);
	const cursor = event.url.searchParams.get('cursor') ?? undefined;
	const { keys, agents, nextCursor } = await valueOrFail(event, await adminApi.listHeadlessKeys({ cursor }));
	// The new key shows one time: it lives in the session only until this load reads it.
	const newKey = event.locals.session.get('newHeadlessKey');
	if (newKey) await event.locals.session.delete('newHeadlessKey');
	return {
		heading: 'Headless agents',
		keys,
		agents,
		nextCursor,
		cursor: cursor ?? '',
		newKey: newKey ?? null,
		errorMessage: errorMessages[event.url.searchParams.get('error') as AdminFailure] ?? null,
		doneMessage: doneMessages[event.url.searchParams.get('done') ?? ''] ?? null,
		confirming: event.url.searchParams.get('confirm') ?? '',
		limits: { labelMaxLength, agentNameMaxLength, maxExpiryDays },
		nowMs: Date.now(),
	};
};

export const actions: Actions = {
	default: async (event) => {
		const adminApi = await adminOnlyApi(event);
		const form = await event.request.formData();
		const field = (name: string) => {
			const value = form.get(name);
			return typeof value === 'string' ? value : '';
		};
		const action = field('action');
		const cursor = field('cursor');
		if (action === 'rotate') return flashNewKey(event, await adminApi.rotateHeadlessKey({ keyId: field('keyId') }), cursor, true);
		if (action === 'revoke-key') return redirectAfter(event, await adminApi.revokeHeadlessKey({ keyId: field('keyId') }), 'revoked-key', cursor);
		if (action === 'revoke-agent') return redirectAfter(event, await adminApi.revokeHeadlessAgent({ handle: field('handle') }), 'revoked-agent', cursor);
		if (action !== 'create') error(400, 'Request not accepted');
		const values: CreateValues = { label: field('label').trim(), suggestedName: normalizedAgentName(field('suggestedName')), expiresInDays: field('expiresInDays').trim() };
		let errors = createFieldErrors(values);
		let failure: string | null = null;
		if (Object.keys(errors).length === 0) {
			const created = await adminApi.createHeadlessKey({ label: values.label, suggestedName: values.suggestedName, expiresInDays: Number(values.expiresInDays) });
			if (created.ok) return flashNewKey(event, created, cursor, false);
			if (created.error === 'unauthorized') return failPage(event, created.error);
			if (created.error === 'invalid') errors = { suggestedName: 'backchannels does not allow that name. Choose another, for example one that ends in -agent.' };
			else failure = errorMessages[created.error] ?? 'backchannels could not create the key. Try again.';
		}
		return fail(422, { values, errors, failure });
	},
};
