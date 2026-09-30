// Starting limits (BUILD.md). They protect the single Durable Object per workspace.

export const LIMITS = {
  handleLength: 40,
  channelNameLength: 80,
  messageLength: 40_000,
  groupChatMembers: 9,
  registerAgentPerDay: 20,
  liveAgentsPerCarbonUnit: 50,
  liveAgentsPerWorkspaceOwner: 50,
  lastUsedWriteMs: 60_000,
  googleRecheckMs: 24 * 60 * 60 * 1000,
  googleRecheckGraceMs: 3 * 24 * 60 * 60 * 1000,
  sponsorLivenessMs: 7 * 24 * 60 * 60 * 1000,
  headlessKeyMaxDays: 90,
  headlessKeyOverlapMs: 24 * 60 * 60 * 1000,
  headlessKeysPerPage: 50,
  headlessKeyLabelLength: 80,
  maxFileBytes: 5 * 1024 * 1024,
  inlineTextMaxBytes: 100 * 1024,
  fileNameLength: 200,
  filesPerMessage: 10,
} as const;

export interface RateLimit {
  bucket: string;
  per: "agent" | "installation";
  count: number;
  windowMs: number;
  label: string;
}

const MINUTE = 60_000;
const send: RateLimit = { bucket: "send", per: "agent", count: 30, windowMs: MINUTE, label: "sends, edits and reactions" };
const read: RateLimit = { bucket: "read", per: "agent", count: 120, windowMs: MINUTE, label: "reads" };
const searchPerAgent: RateLimit = { bucket: "search", per: "agent", count: 60, windowMs: MINUTE, label: "searches" };
const searchPerInstallation: RateLimit = {
  bucket: "search",
  per: "installation",
  count: 120,
  windowMs: MINUTE,
  label: "searches from one sign-in",
};

export const RATE_LIMITS: Record<string, RateLimit[]> = {
  send_message: [send],
  edit_message: [send],
  react: [send],
  read_messages: [read],
  check_inbox: [read],
  search_messages: [searchPerAgent, searchPerInstallation],
  upload_file: [{ bucket: "upload", per: "agent", count: 20, windowMs: 60 * MINUTE, label: "file uploads" }],
  create_channel: [{ bucket: "channel", per: "agent", count: 10, windowMs: 60 * MINUTE, label: "new channels" }],
};
