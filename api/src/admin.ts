export type Scope = "mine" | "everyone";
export type DirectoryKind = "public" | "private";
export type ConversationSort = "active" | "recent" | "name";

export type AdminResult<Value> =
  | { ok: true; value: Value }
  | { ok: false; error: "unauthorized" | "not_found" | "invalid" | "reserved_owner_taken" | "already_rotated" | "sponsor_not_verified" };

export interface AdminSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface Viewer {
  email: string;
  name: string | null;
  workspaceName: string;
  isAdmin: boolean;
}

export interface Conversation {
  id: string;
  name: string;
  kind: "public" | "private" | "dm" | "group";
  isPrivate: boolean;
  topic: string;
  members: string[];
  people: number;
  messagesToday: number;
  lastActivity: string | null;
  isMine: boolean;
  preview: string;
}

export interface Message {
  seq: number;
  person: string;
  personEmail: string;
  agent: string;
  time: string;
  text: string;
  isOwn: boolean;
  threadReplies: number;
  lastReplyAt: string | null;
  reactions: Reaction[];
}

export interface Reaction {
  emoji: string;
  agents: string[];
}

export interface SearchMatch {
  conversation: { id: string; name: string; isPrivate: boolean };
  message: Message;
  ranges: [number, number][];
}

export interface Installation {
  grantId: string;
  clientName: string | null;
  createdAt: string;
  lastUsedAt: string;
}

export interface HeadlessKey {
  id: string;
  label: string;
  suggestedName: string;
  keyHint: string;
  sponsorEmail: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  rotatedFrom: string | null;
  hasSuccessor: boolean;
}

export interface HeadlessAgent {
  handle: string;
  description: string;
  lastActiveAt: string;
}

export interface NewHeadlessKey {
  keyId: string;
  key: string;
  label: string;
}

export interface AdminApiRpc {
  adminSignInUrl(input: { redirectUri: string; state: string; codeChallenge: string }): Promise<AdminResult<string>>;
  exchangeAdminCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<AdminResult<AdminSession>>;
  refreshAdminSession(input: { refreshToken: string; redirectUri: string }): Promise<AdminResult<AdminSession>>;
  revokeAdminSession(input: { refreshToken: string; redirectUri: string }): Promise<AdminResult<null>>;
  viewer(token: string): Promise<AdminResult<Viewer>>;
  listConversations(
    token: string,
    options: { scope: Scope; kind?: DirectoryKind; sort?: ConversationSort; filter?: string; cursor?: string },
  ): Promise<AdminResult<{ conversations: Conversation[]; totals: { public: number; publicMine: number; private: number }; nextCursor?: string }>>;
  readConversation(
    token: string,
    options: { conversation: string; thread?: number; before?: number; limit?: number },
  ): Promise<AdminResult<{ conversation: Conversation; messages: Message[]; nextBefore?: number }>>;
  search(
    token: string,
    options: { query: string; scope: Scope; cursor?: string },
  ): Promise<AdminResult<{ matches: SearchMatch[]; nextCursor?: string }>>;
  listInstallations(token: string): Promise<AdminResult<{ installations: Installation[] }>>;
  revokeInstallation(token: string, options: { grantId: string }): Promise<AdminResult<null>>;
  listHeadlessKeys(
    token: string,
    options: { cursor?: string },
  ): Promise<AdminResult<{ keys: HeadlessKey[]; agents: HeadlessAgent[]; nextCursor?: string }>>;
  createHeadlessKey(
    token: string,
    options: { label: string; suggestedName: string; expiresInDays: number },
  ): Promise<AdminResult<NewHeadlessKey>>;
  rotateHeadlessKey(token: string, options: { keyId: string }): Promise<AdminResult<NewHeadlessKey>>;
  revokeHeadlessKey(token: string, options: { keyId: string }): Promise<AdminResult<null>>;
  revokeHeadlessAgent(token: string, options: { handle: string }): Promise<AdminResult<null>>;
}
