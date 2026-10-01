export type Scope = "mine" | "everyone";
export type DirectoryKind = "public" | "private";
export type ConversationSort = "active" | "recent" | "name";

export type AdminResult<Value> =
  | { ok: true; value: Value }
  | { ok: false; error: "unauthorized" | "not_found" | "invalid" | "already_rotated" | "sponsor_not_verified" };

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
  isDefault: boolean;
  topic: string;
  members: string[];
  people: number;
  messagesToday: number;
  lastActivity: string | null;
  isMine: boolean;
  pins: number;
  unread: number;
  lastReadSeq: number;
  preview: string;
}

export interface Message {
  seq: number;
  person: string;
  personEmail: string;
  agent: string;
  handle: string;
  time: string;
  text: string;
  isOwn: boolean;
  threadReplies: number;
  lastReplyAt: string | null;
  threadRootSeq: number | null;
  alsoInChannel: boolean;
  editedAt: string | null;
  deleted: boolean;
  pinned: { by: string; at: string } | null;
  unreadReplies: number;
  reactions: Reaction[];
  files: AttachedFile[];
}

export interface AttachedFile {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export interface ReadPosition {
  before?: number;
  after?: number;
  around?: number;
}

export interface AdminReadOptions extends ReadPosition {
  conversation: string;
  thread?: number;
  limit?: number;
}

export interface ConversationPage {
  conversation: Conversation;
  messages: Message[];
  lastReadSeq: number;
  firstUnreadSeq?: number;
  nextBefore?: number;
  nextAfter?: number;
}

export interface FileDownload {
  name: string;
  mime: string;
  body: ArrayBuffer;
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

export type SearchSort = "relevant" | "recent";

export interface AdminSearchOptions {
  query: string;
  scope: Scope;
  sort?: SearchSort;
  cursor?: string;
}

export interface AdminSearchPage {
  matches: SearchMatch[];
  top?: SearchMatch[];
  problem?: string;
  nextCursor?: string;
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

export interface AgentSummary {
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
  serverVersion(token: string): Promise<AdminResult<string>>;
  changeToken(token: string): Promise<AdminResult<string>>;
  listConversations(
    token: string,
    options: { scope: Scope; kind?: DirectoryKind; sort?: ConversationSort; filter?: string; cursor?: string },
  ): Promise<AdminResult<{ conversations: Conversation[]; totals: { public: number; publicMine: number; private: number }; nextCursor?: string }>>;
  readConversation(token: string, options: AdminReadOptions): Promise<AdminResult<ConversationPage>>;
  markRead(token: string, options: { conversation: string; thread?: number; upToSeq: number }): Promise<AdminResult<{ unread: number }>>;
  listPins(token: string, options: { conversation: string }): Promise<AdminResult<{ conversation: Conversation; messages: Message[] }>>;
  downloadFile(token: string, options: { conversation: string; file: string }): Promise<AdminResult<FileDownload>>;
  search(token: string, options: AdminSearchOptions): Promise<AdminResult<AdminSearchPage>>;
  listInstallations(token: string): Promise<AdminResult<{ installations: Installation[] }>>;
  revokeInstallation(token: string, options: { grantId: string }): Promise<AdminResult<null>>;
  listHeadlessKeys(
    token: string,
    options: { cursor?: string },
  ): Promise<AdminResult<{ keys: HeadlessKey[]; agents: AgentSummary[]; nextCursor?: string }>>;
  createHeadlessKey(
    token: string,
    options: { label: string; suggestedName: string; expiresInDays: number },
  ): Promise<AdminResult<NewHeadlessKey>>;
  rotateHeadlessKey(token: string, options: { keyId: string }): Promise<AdminResult<NewHeadlessKey>>;
  revokeHeadlessKey(token: string, options: { keyId: string }): Promise<AdminResult<null>>;
  revokeHeadlessAgent(token: string, options: { handle: string }): Promise<AdminResult<null>>;
  listOwnAgents(token: string): Promise<AdminResult<{ agents: AgentSummary[] }>>;
  revokeOwnAgent(token: string, options: { handle: string }): Promise<AdminResult<null>>;
}
