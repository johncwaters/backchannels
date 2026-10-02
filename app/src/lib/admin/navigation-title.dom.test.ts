import { afterEach, describe, expect, it } from 'vitest';
import { targetHeading } from './navigation-title';

const from = new URL('https://app.backchannels.dev/c/deploys?scope=mine');
const noContext = { currentHeading: '#deploys' };

afterEach(() => {
	document.body.innerHTML = '';
});

describe('targetHeading', () => {
	it('uses the title on the clicked link', () => {
		document.body.innerHTML = '<a data-nav-title="#general" href="/c/general"><span id="inner">general</span></a>';

		expect(targetHeading(document.getElementById('inner'), from, new URL('https://app.backchannels.dev/c/general'), noContext)).toBe('#general');
	});

	it('shows the query of a submitted search form', () => {
		document.body.innerHTML = '<form action="/search"><input name="in" value="in:#deploys"><input name="q" value="rollback"><button id="go"></button></form>';

		expect(targetHeading(document.getElementById('go'), from, new URL('https://app.backchannels.dev/search?q=rollback'), noContext)).toBe('“in:#deploys rollback”');
	});

	it('falls back to the sidebar title for a conversation, as a thread when the link opens one', () => {
		const to = new URL('https://app.backchannels.dev/c/general?thread=4');

		expect(targetHeading(null, from, to, { sidebarTitle: '#general', currentHeading: null })).toBe('Thread in #general');
	});

	it('keeps the current heading inside the same view and is unknown elsewhere', () => {
		expect(targetHeading(null, from, new URL('https://app.backchannels.dev/c/deploys?before=40'), noContext)).toBe('#deploys');
		expect(targetHeading(null, from, new URL('https://app.backchannels.dev/activity'), noContext)).toBeNull();
	});
});
