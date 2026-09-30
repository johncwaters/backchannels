import type { Conversation, ConversationSort } from '../../../admin/types';

export type PrivacyMarker = 'dm' | 'lock' | null;

export interface ConversationLabel {
	shownName: string;
	fullName: string;
	hiddenMemberCount: number;
}

function isMemberListName(conversation: Pick<Conversation, 'kind' | 'members'>): boolean {
	return (conversation.kind === 'dm' || conversation.kind === 'group') && conversation.members.length > 0;
}

function ownerOf(handle: string): string {
	return handle.replace(/^@/, '').split('/')[0];
}

function isViewersHandle(handle: string, viewerEmail: string | undefined): boolean {
	return viewerEmail !== undefined && ownerOf(handle) === viewerEmail.split('@')[0];
}

function membersWithViewerLast(members: string[], viewerEmail: string | undefined): string[] {
	const isViewers = (handle: string) => isViewersHandle(handle, viewerEmail);
	return [...members.filter((handle) => !isViewers(handle)), ...members.filter(isViewers)];
}

export function conversationLabel(conversation: Pick<Conversation, 'kind' | 'name' | 'members'>, viewerEmail?: string): ConversationLabel {
	if (!isMemberListName(conversation) || conversation.members.length === 1) {
		return { shownName: conversation.name, fullName: conversation.name, hiddenMemberCount: 0 };
	}
	const [firstMember] = membersWithViewerLast(conversation.members, viewerEmail);
	const isDirectMessageWithViewer = conversation.kind === 'dm' && conversation.members.length === 2 && conversation.members.some((handle) => isViewersHandle(handle, viewerEmail));
	const hiddenMemberCount = isDirectMessageWithViewer ? 0 : conversation.members.length - 1;
	return { shownName: firstMember, fullName: conversation.members.join(', '), hiddenMemberCount };
}

export function privacyMarkerFor(conversation: Pick<Conversation, 'kind' | 'isPrivate'>): PrivacyMarker {
	if (conversation.kind === 'dm') return 'dm';
	return conversation.isPrivate ? 'lock' : null;
}

export function messagesTodayLabel(messagesToday: number): string {
	return messagesToday === 1 ? '1 message today' : `${messagesToday} messages today`;
}

export function aboutTextFor(conversation: Pick<Conversation, 'topic' | 'preview'>): { text: string; isTopic: boolean } {
	const topic = conversation.topic.trim();
	return topic ? { text: topic, isTopic: true } : { text: conversation.preview, isTopic: false };
}

export const sortDirections: Record<ConversationSort, 'ascending' | 'descending'> = {
	name: 'ascending',
	active: 'descending',
	recent: 'descending',
};
