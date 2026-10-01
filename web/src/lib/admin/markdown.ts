import MarkdownIt from 'markdown-it';
import type { StateCore, Token } from 'markdown-it';
import { agentColorAmong } from './helpers';

const untrustedLinkRel = 'nofollow noopener noreferrer';
const mentionPattern = /(^|[^\w@/])@(?:([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9_-]*)|(channel|here)(?![\w./-]))/gi;
const messageMarkdown = new MarkdownIt({ html: false, linkify: true, breaks: true }).disable('image');

messageMarkdown.renderer.rules.link_open = (tokens, index, options, _environment, renderer) => {
	tokens[index].attrSet('rel', untrustedLinkRel);
	tokens[index].attrSet('target', '_blank');
	return renderer.renderToken(tokens, index, options);
};

type MentionRenderEnvironment = {
	colorByHandle?: ReadonlyMap<string, string>;
};

function mentionColor(state: StateCore, mentionedHandle: string): string {
	const { colorByHandle } = state.env as MentionRenderEnvironment;
	return agentColorAmong(colorByHandle, mentionedHandle);
}

function mentionTokens(state: StateCore, text: string): Token[] {
	const tokens: Token[] = [];
	const pushText = (content: string) => {
		if (!content) return;
		const textToken = new state.Token('text', '', 0);
		textToken.content = content;
		tokens.push(textToken);
	};
	let consumedUpTo = 0;
	for (const match of text.matchAll(mentionPattern)) {
		const [whole, leadingCharacter, owner, agentName, broadcast] = match;
		const mentionStart = match.index + leadingCharacter.length;
		pushText(text.slice(consumedUpTo, mentionStart));
		const openToken = new state.Token('mention_open', 'span', 1);
		openToken.attrSet('class', broadcast ? 'mention mention-broadcast' : 'mention');
		if (agentName) openToken.attrSet('style', `color: ${mentionColor(state, `${owner}/${agentName}`)}`);
		tokens.push(openToken);
		pushText(whole.slice(leadingCharacter.length));
		tokens.push(new state.Token('mention_close', 'span', -1));
		consumedUpTo = match.index + whole.length;
	}
	pushText(text.slice(consumedUpTo));
	return tokens;
}

messageMarkdown.core.ruler.push('mentions', (state) => {
	for (const blockToken of state.tokens) {
		if (blockToken.type !== 'inline' || !blockToken.children) continue;
		let linkDepth = 0;
		blockToken.children = blockToken.children.flatMap((token) => {
			if (token.type === 'link_open') linkDepth += 1;
			if (token.type === 'link_close') linkDepth -= 1;
			if (token.type !== 'text' || linkDepth > 0) return [token];
			return mentionTokens(state, token.content);
		});
	}
});

export function renderMessageMarkdown(messageText: string, colorByHandle?: ReadonlyMap<string, string>): string {
	const environment: MentionRenderEnvironment = { colorByHandle };
	return messageMarkdown.render(messageText, environment);
}
