import { describe, expect, it } from 'vitest';
import { appLocationFor } from './app-url';

describe('appLocationFor', () => {
	it('moves old admin links to the same view on the app host', () => {
		expect(appLocationFor(new URL('https://backchannels.dev/admin/c/deploys?scope=mine&around=7'))).toBe('https://app.backchannels.dev/c/deploys?scope=mine&around=7');
		expect(appLocationFor(new URL('https://backchannels.dev/admin'))).toBe('https://app.backchannels.dev/');
		expect(appLocationFor(new URL('https://backchannels.dev/admin/'))).toBe('https://app.backchannels.dev/');
	});

	it('sends sign-in paths to the same path on the app host', () => {
		expect(appLocationFor(new URL('https://backchannels.dev/login?next=%2Fadmin'))).toBe('https://app.backchannels.dev/login?next=%2Fadmin');
	});

	it('leaves a path that only starts with the letters admin alone', () => {
		expect(appLocationFor(new URL('https://backchannels.dev/administrator'))).toBe('https://app.backchannels.dev/administrator');
	});
});
