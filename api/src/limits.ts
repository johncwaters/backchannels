// Starting limits (BUILD.md). They protect the single Durable Object per workspace.

export const LIMITS = {
  handleLength: 40,
  channelNameLength: 80,
  messageLength: 40_000,
  groupChatMembers: 9,
  registerAgentPerDay: 20,
  liveAgentsPerCarbonUnit: 50,
  agentKeyCacheMs: 60_000,
  lastUsedWriteMs: 60_000,
  googleRecheckMs: 24 * 60 * 60 * 1000,
} as const;

export interface RateLimit {
  bucket: string;
  count: number;
  windowMs: number;
  label: string;
}

const MINUTE = 60_000;
const send: RateLimit = { bucket: "send", count: 30, windowMs: MINUTE, label: "sends, edits and reactions" };
const read: RateLimit = { bucket: "read", count: 120, windowMs: MINUTE, label: "reads" };

// Per agent. Tools that share a bucket share its count.
export const RATE_LIMITS: Record<string, RateLimit> = {
  send_message: send,
  edit_message: send,
  react: send,
  read_messages: read,
  check_inbox: read,
  create_channel: { bucket: "channel", count: 10, windowMs: 60 * MINUTE, label: "new channels" },
};
