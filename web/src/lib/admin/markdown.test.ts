import { describe, expect, it } from 'vitest';
import { renderMessageMarkdown } from './markdown';

describe('renderMessageMarkdown', () => {
	it('renders emphasis, inline code and lists', () => {
		const html = renderMessageMarkdown('**bold** and `code`\n\n- one\n- two');
		expect(html).toContain('<strong>bold</strong>');
		expect(html).toContain('<code>code</code>');
		expect(html).toContain('<ul>\n<li>one</li>');
	});

	it('renders fenced code blocks with a language class', () => {
		expect(renderMessageMarkdown('```ts\nconst x = 1;\n```')).toContain('<pre><code class="language-ts">const x = 1;\n</code></pre>');
	});

	it('keeps single newlines as line breaks', () => {
		expect(renderMessageMarkdown('first\nsecond')).toBe('<p>first<br>\nsecond</p>\n');
	});

	it('escapes raw html instead of rendering it', () => {
		const html = renderMessageMarkdown('<script>alert(1)</script><img src=x onerror=alert(1)>');
		expect(html).not.toContain('<script');
		expect(html).not.toContain('<img');
		expect(html).toContain('&lt;script&gt;');
	});

	it('drops javascript links', () => {
		expect(renderMessageMarkdown('[click](javascript:alert(1))')).not.toContain('href');
	});

	it('marks links untrusted and opens them in a new tab', () => {
		expect(renderMessageMarkdown('see https://example.com')).toContain(
			'<a href="https://example.com" rel="nofollow noopener noreferrer" target="_blank">https://example.com</a>',
		);
	});

	it('never loads remote images', () => {
		const html = renderMessageMarkdown('![pixel](https://tracker.example/p.gif)');
		expect(html).not.toContain('<img');
	});
});

describe('mentions', () => {
	it('wraps an agent mention in a span colored like that agent', () => {
		expect(renderMessageMarkdown('ping @ian.m/deploy-agent now')).toMatch(
			/^<p>ping <span class="mention" style="color: var\(--agent-[a-z-]+\)">@ian\.m\/deploy-agent<\/span> now<\/p>/,
		);
	});

	it('marks @channel and @here as broadcasts', () => {
		const html = renderMessageMarkdown('@channel and @here');
		expect(html).toContain('<span class="mention mention-broadcast">@channel</span>');
		expect(html).toContain('<span class="mention mention-broadcast">@here</span>');
	});

	it('leaves emails, code and link text alone', () => {
		expect(renderMessageMarkdown('mail ian@example.com/x')).not.toContain('mention');
		expect(renderMessageMarkdown('`@ian.m/deploy-agent`')).not.toContain('mention');
		expect(renderMessageMarkdown('[@ian.m/deploy-agent](https://example.com)')).not.toContain('mention');
		expect(renderMessageMarkdown('@channelx')).not.toContain('mention');
	});

	it('handles underscores in agent names', () => {
		expect(renderMessageMarkdown('@ian.m/deploy_agent_two')).toContain('>@ian.m/deploy_agent_two</span>');
	});
});
