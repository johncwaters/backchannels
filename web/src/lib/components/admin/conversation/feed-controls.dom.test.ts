import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newMessagesText } from './feed-controls';

const jumpLabel = 'Jump to latest ↓';
const copyLinkLabel = 'copy link';

function renderConversation(): void {
	document.body.innerHTML = `
		<section data-live="messages"><article id="m-1">first</article></section>
		<div data-jump-controls hidden>
			<span id="new-arrivals-count" data-new-arrivals hidden></span>
			<button data-jump-to-latest aria-describedby="new-arrivals-count">Jump to latest <span aria-hidden="true">↓</span></button>
		</div>
		<button type="button" data-copy-link="/admin/c/general?around=1#m-1">copy link</button>
		<p role="status" data-copy-status></p>`;
}

function feed(): HTMLElement {
	return document.querySelector<HTMLElement>('[data-live="messages"]')!;
}

function jumpButton(): HTMLButtonElement {
	return document.querySelector<HTMLButtonElement>('[data-jump-to-latest]')!;
}

function arrivalCount(): HTMLElement {
	return document.querySelector<HTMLElement>('[data-new-arrivals]')!;
}

function copyLinkButton(): HTMLButtonElement {
	return document.querySelector<HTMLButtonElement>('button[data-copy-link]')!;
}

function copyStatusText(): string | null {
	return document.querySelector('[data-copy-status]')!.textContent;
}

function scrollFeedAwayFromLatest(): void {
	Object.defineProperty(feed(), 'scrollHeight', { configurable: true, value: 5000 });
	Object.defineProperty(feed(), 'clientHeight', { configurable: true, value: 500 });
	feed().scrollTop = 0;
	feed().dispatchEvent(new Event('scroll'));
}

async function receiveMessage(id: string): Promise<void> {
	const article = document.createElement('article');
	article.id = id;
	article.dataset.arrived = '';
	feed().appendChild(article);
	await vi.waitFor(() => expect(arrivalCount().hidden).toBe(false));
}

function stubClipboard(writeText: () => Promise<void>): void {
	Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(writeText) } });
}

beforeEach(() => {
	renderConversation();
	document.dispatchEvent(new Event('astro:page-load'));
});

afterEach(() => {
	document.body.innerHTML = '';
});

describe('new messages text', () => {
	it('is empty with no arrivals and counts singular and plural arrivals', () => {
		expect(newMessagesText(0)).toBe('');
		expect(newMessagesText(1)).toBe('1 new message');
		expect(newMessagesText(4)).toBe('4 new messages');
	});
});

describe('jump to latest', () => {
	it('shows beside the feed only when the reader is away from the latest message', () => {
		expect(jumpButton().closest<HTMLElement>('[data-jump-controls]')!.hidden).toBe(true);

		scrollFeedAwayFromLatest();

		expect(jumpButton().closest<HTMLElement>('[data-jump-controls]')!.hidden).toBe(false);
	});

	it('keeps its label while the new message count shows next to it', async () => {
		scrollFeedAwayFromLatest();

		await receiveMessage('m-2');

		expect(jumpButton().textContent).toBe(jumpLabel);
		expect(arrivalCount().textContent).toBe('1 new message');
		expect(jumpButton().getAttribute('aria-describedby')).toBe(arrivalCount().id);
	});
});

describe('copy link', () => {
	it('keeps its label and announces the copy through the status region', async () => {
		stubClipboard(() => Promise.resolve());

		copyLinkButton().click();

		await vi.waitFor(() => expect(copyStatusText()).toBe('Link to message copied'));
		expect(copyLinkButton().textContent).toBe(copyLinkLabel);
		expect(navigator.clipboard.writeText).toHaveBeenCalledWith(new URL('/admin/c/general?around=1#m-1', location.href).href);
	});

	it('keeps its label and announces a failed copy through the status region', async () => {
		stubClipboard(() => Promise.reject(new Error('denied')));

		copyLinkButton().click();

		await vi.waitFor(() => expect(copyStatusText()).toBe('Could not copy the link'));
		expect(copyLinkButton().textContent).toBe(copyLinkLabel);
	});
});
