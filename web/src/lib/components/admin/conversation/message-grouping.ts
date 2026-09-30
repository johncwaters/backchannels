import type { Message } from '../../../admin/types';

const groupingWindowMs = 5 * 60_000;

interface GroupingContext {
	threadRootSeq?: number;
	targetSeq?: number;
}

function sameAuthor(message: Message, previous: Message): boolean {
	return message.personEmail === previous.personEmail && message.person === previous.person && message.agent === previous.agent;
}

function postedSoonAfter(message: Message, previous: Message): boolean {
	const gapMs = Date.parse(message.time) - Date.parse(previous.time);
	return gapMs >= 0 && gapMs <= groupingWindowMs;
}

export function continuesPreviousMessage(message: Message, previous: Message | undefined, context: GroupingContext): boolean {
	if (!previous) return false;
	if (message.seq === context.targetSeq || previous.seq === context.threadRootSeq) return false;
	if (previous.threadReplies > 0) return false;
	return sameAuthor(message, previous) && postedSoonAfter(message, previous);
}
