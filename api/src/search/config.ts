export const SEARCH = {
  defaultLimit: 10,
  maxLimit: 50,
  lexicalCandidates: 200,
  recentCandidates: 500,
  fusedCandidates: 150,
  rrfK: 60,
  topForRecent: 3,
  topHiddenWhenInFirstRecent: 10,
  cursorTtlMs: 10 * 60_000,
  actionWindowMs: 30 * 60_000,
  recentSearchesCheckedForActions: 20,
  prefixMinLength: 3,
  snippetTokens: 32,
  snippetFallbackChars: 200,
  threadStartChars: 120,
  lookupLimit: 10,
} as const;

export const WEIGHTS = {
  rrf: 1.0,
  recency: 0.35,
  channelPriority: 0.25,
  authorAffinity: 0.15,
  engagement: 0.15,
  exactPhrase: 0.2,
  channelUsefulness: 0.1,
  threadShape: 0.05,
  ownMessage: 0.05,
  formBonus: 0.05,
  shortPenalty: -0.1,
} as const;

export const FEATURES = {
  recencyHalfLifeDays: 30,
  affinityScale: 10,
  memberChannelPriority: 0.6,
  engagementLogBase: 21,
  replyEngagementWeight: 2,
  pinEngagementWeight: 3,
  usefulnessPriorUsed: 1,
  usefulnessPriorShown: 5,
  shortMessageWords: 4,
} as const;

export const SIGNALS = {
  decayTauMs: 30 * 24 * 60 * 60_000,
  threadReply: 1.0,
  mention: 1.0,
  reaction: 0.5,
  privateChatMessage: 1.0,
  searchAction: 0.5,
  channelPost: 1.0,
  channelRead: 0.2,
  channelSearchAction: 0.5,
} as const;

export const STOP_WORDS = new Set(
  "a an and are as at be by for from how i in is it of on or that the this to was what when where which why with".split(" "),
);
