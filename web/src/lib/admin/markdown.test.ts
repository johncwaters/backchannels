import { describe, expect, it } from 'vitest';
import { distinctAgentColors } from './helpers';
import { renderMessageMarkdown } from './markdown';

describe('renderMessageMarkdown', () => {
	it('renders emphasis, inline code and lists', () => {
		const html = renderMessageMarkdown('**bold** and `code`\n\n- one\n- two');
		expect(html).toContain('<strong>bold</strong>');
		expect(html).toContain('<code>code</code>');
		expect(html).toContain('<ul>\n<li>one</li>');
	});

	it('renders fenced code blocks with a language class', () => {
		expect(renderMessageMarkdown('```ts\nconst x = 1;\n```')).toContain('<pre tabindex="0" role="region" aria-label="Code block"><code class="language-ts">const x = 1;\n</code></pre>');
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

	it.each([
		['data', '[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)'],
		['data image', '[click](data:image/svg+xml;base64,PHN2Zy8+)'],
		['vbscript', '[click](vbscript:msgbox(1))'],
		['entity-encoded javascript', '[click](javascript&colon;alert(1))'],
		['numeric-entity javascript', '[click](&#106;avascript:alert(1))'],
		['mixed-case javascript', '[click](JaVaScRiPt:alert(1))'],
		['autolinked vbscript', '<vbscript:msgbox(1)>'],
		['autolinked data', '<data:text/html,hi>'],
	])('drops %s links', (_scheme, markdown) => {
		expect(renderMessageMarkdown(markdown)).not.toContain('href');
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
			/^<p>ping <span class="mention" style="color: oklch\(0\.8 0\.12 [\d.]+\)">@ian\.m\/deploy-agent<\/span> now<\/p>/,
		);
	});

	it('colors an agent mention with the supplied handle color map before the hash', () => {
		const colorByHandle = new Map([['ian.m/deploy-agent', 'oklch(0.8 0.12 200.0)']]);
		expect(renderMessageMarkdown('ping @ian.m/deploy-agent now', colorByHandle)).toContain(
			'<span class="mention" style="color: oklch(0.8 0.12 200.0)">@ian.m/deploy-agent</span>',
		);
	});

	it('colors a differently cased mention with the color mapped to its author', () => {
		const colorByAuthor = distinctAgentColors(['@Ian.M/deploy-agent', 'maya/claude']);
		expect(renderMessageMarkdown('ping @IAN.m/Deploy-Agent now', colorByAuthor)).toContain(
			`<span class="mention" style="color: ${colorByAuthor.get('ian.m/deploy-agent')}">@IAN.m/Deploy-Agent</span>`,
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
