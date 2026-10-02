import { error, fail, type RequestEvent } from '@sveltejs/kit';
import type { AdminResult, NewHeadlessKey } from '#lib/admin/types.ts';
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

async function formField(event: RequestEvent, name: string): Promise<string> {
	const value = (await event.request.formData()).get(name);
	return typeof value === 'string' ? value : '';
}

// A rejection the admin can act on comes back as an error message; a dead grant still goes through sign-in.
async function failure(event: RequestEvent, rejection: AdminFailure) {
	if (rejection === 'unauthorized') return failPage(event, rejection);
	return fail(rejection === 'not_found' ? 404 : 400, { error: errorMessages[rejection] ?? 'backchannels could not do that. Try again.' });
}

// The new key goes straight back to this browser in the action result, and nowhere else.
async function keyResult(event: RequestEvent, result: AdminResult<NewHeadlessKey>, wasRotated: boolean) {
	if (!result.ok) return failure(event, result.error);
	return { newKey: { ...result.value, wasRotated } };
}

export const load: PageServerLoad = async (event) => {
	const adminApi = await adminOnlyApi(event);
	const cursor = event.url.searchParams.get('cursor') ?? undefined;
	const { keys, agents, nextCursor } = await valueOrFail(event, await adminApi.listHeadlessKeys({ cursor }));
	return {
		heading: 'Headless agents',
		keys,
		agents,
		nextCursor,
		cursor,
		limits: { labelMaxLength, agentNameMaxLength, maxExpiryDays },
		nowMs: Date.now(),
	};
};

export const actions: Actions = {
	create: async (event) => {
		const adminApi = await adminOnlyApi(event);
		const form = await event.request.formData();
		const field = (name: string) => {
			const value = form.get(name);
			return typeof value === 'string' ? value : '';
		};
		const values: CreateValues = { label: field('label').trim(), suggestedName: normalizedAgentName(field('suggestedName')), expiresInDays: field('expiresInDays').trim() };
		const errors = createFieldErrors(values);
		if (Object.keys(errors).length > 0) return fail(422, { values, errors });
		const created = await adminApi.createHeadlessKey({ label: values.label, suggestedName: values.suggestedName, expiresInDays: Number(values.expiresInDays) });
		if (created.ok) return keyResult(event, created, false);
		if (created.error === 'unauthorized') return failPage(event, created.error);
		if (created.error === 'invalid') return fail(422, { values, errors: { suggestedName: 'backchannels does not allow that name. Choose another, for example one that ends in -agent.' } });
		return fail(400, { values, errors: {}, error: errorMessages[created.error] ?? 'backchannels could not create the key. Try again.' });
	},
	rotate: async (event) => {
		const adminApi = await adminOnlyApi(event);
		return keyResult(event, await adminApi.rotateHeadlessKey({ keyId: await formField(event, 'keyId') }), true);
	},
	revokeKey: async (event) => {
		const adminApi = await adminOnlyApi(event);
		const revoked = await adminApi.revokeHeadlessKey({ keyId: await formField(event, 'keyId') });
		if (!revoked.ok) return failure(event, revoked.error);
		return { notice: 'Key revoked. Agents that used it get 401 on their next call.' };
	},
	revokeAgent: async (event) => {
		const adminApi = await adminOnlyApi(event);
		const revoked = await adminApi.revokeHeadlessAgent({ handle: await formField(event, 'handle') });
		if (!revoked.ok) return failure(event, revoked.error);
		return { notice: 'Agent revoked. Its handle cannot be registered again.' };
	},
};
