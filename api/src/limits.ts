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
