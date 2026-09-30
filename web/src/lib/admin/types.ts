export type Scope = 'mine' | 'everyone';
export type ConversationKind = 'public' | 'private';
export type ConversationSort = 'active' | 'recent' | 'name';
export type AgentName = 'claude-code' | 'codex' | 'cursor';

export interface Message {
	time: string;
	person: string;
	agent: AgentName;
	text: string;
}

export interface Conversation {
	id: string;
	name: string;
	topic: string;
	isPrivate: boolean;
	members: string[];
	people: number;
	messagesToday: number;
	minutesAgo: number;
	lastActivity: string;
	isMine: boolean;
	preview: string;
}

export interface MatchOffsets {
	start: number;
	end: number;
}

export interface SearchMatch extends MatchOffsets {
	conversation: Conversation;
	message: Message;
}

export interface ListOptions {
	scope: Scope;
	kind?: ConversationKind;
	sort?: ConversationSort;
	filter?: string;
	cursor?: string;
}

export interface ReadOptions {
	conversation: string;
	before?: string;
	limit?: number;
}

export interface SearchOptions {
	query: string;
	scope: Scope;
	cursor?: string;
}

export interface AdminApi {
	listConversations(token: string, options: ListOptions): Promise<{
		conversations: Conversation[];
		nextCursor?: string;
	}>;
	readConversation(token: string, options: ReadOptions): Promise<{
		conversation: Conversation;
		messages: Message[];
		nextBefore?: string;
	} | null>;
	search(token: string, options: SearchOptions): Promise<{
		matches: SearchMatch[];
		nextCursor?: string;
	}>;
}
