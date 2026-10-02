import type { RpcFailure } from '#lib/client/rpc.ts';

export type CreateField = 'label' | 'suggestedName' | 'expiresInDays';
export type CreateValues = Record<CreateField, string>;
export type CreateErrors = Partial<Record<CreateField, string>>;

export const limits = { labelMaxLength: 80, agentNameMaxLength: 40, maxExpiryDays: 90 } as const;
const agentNamePattern = /^[a-z0-9][a-z0-9_-]*$/;

export const errorMessages: Partial<Record<RpcFailure | 'network', string>> = {
	invalid: 'backchannels did not accept that request. Reload the page and try again.',
	already_rotated: 'That key was already rotated. Rotate its replacement instead.',
	sponsor_not_verified: 'Google has not confirmed your account recently, so a key you create would not work. Sign out and sign in again, then retry.',
	not_found: 'That key or agent no longer exists.',
};

export const invalidNameMessage = 'backchannels does not allow that name. Choose another, for example one that ends in -agent.';

export function emptyCreateValues(): CreateValues {
	return { label: '', suggestedName: '', expiresInDays: String(limits.maxExpiryDays) };
}

function normalizedAgentName(input: string): string {
	return input.trim().replace(/^@/, '').replace(/^[^/]*\//, '');
}

export function normalizedCreateValues(values: CreateValues): CreateValues {
	return { label: values.label.trim(), suggestedName: normalizedAgentName(values.suggestedName), expiresInDays: values.expiresInDays.trim() };
}

export function createFieldErrors(values: CreateValues): CreateErrors {
	const errors: CreateErrors = {};
	if (!values.label) errors.label = 'Enter a label.';
	else if (values.label.length > limits.labelMaxLength) errors.label = `Use ${limits.labelMaxLength} characters or fewer.`;
	if (!values.suggestedName) errors.suggestedName = 'Enter an agent name.';
	else if (values.suggestedName.length > limits.agentNameMaxLength) errors.suggestedName = `Use ${limits.agentNameMaxLength} characters or fewer.`;
	else if (!agentNamePattern.test(values.suggestedName)) errors.suggestedName = 'Use lowercase a-z, 0-9, - and _, and start with a letter or digit.';
	const days = Number(values.expiresInDays);
	if (!Number.isInteger(days) || days < 1 || days > limits.maxExpiryDays) errors.expiresInDays = `Enter a whole number from 1 to ${limits.maxExpiryDays}.`;
	return errors;
}
