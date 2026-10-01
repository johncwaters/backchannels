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

export const SEMANTIC = {
  embeddingModel: "@cf/qwen/qwen3-embedding-0.6b",
  rerankModel: "@cf/baai/bge-reranker-base",
  queryInstruction: "Given a search query from a software agent, retrieve team chat messages that answer it",
  topK: 100,
  privateIdsPerQuery: 200,
  timeoutMs: 2000,
  embedBatchSize: 32,
  threadDelaySeconds: 60,
  rootContextChars: 200,
  previousContextChars: 200,
  shortMessageWords: 8,
  threadTextMaxChars: 30_000,
  rerankCandidates: 40,
  rerankMinWords: 4,
  rerankBudgetMs: 400,
  rerankTextChars: 1200,
  rerankBlend: 0.5,
  reindexBatchSize: 1000,
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

export const MAX_TRACK_RECORD_BONUS = 0.03;

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
  memberPriorityRequiresPost: false,
  semanticMinScore: 0.5,
  lexicalOnlyMinTerms: 2,
  lexicalOnlyFromTerms: 3,
  trackRecordMaxBonus: MAX_TRACK_RECORD_BONUS,
  trackRecordUsedByCap: 10,
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

export interface Tuning {
  weights: Record<keyof typeof WEIGHTS, number>;
  features: { [Name in keyof typeof FEATURES]: (typeof FEATURES)[Name] extends boolean ? boolean : number };
  rerankBudgetMs: number;
  semanticTimeoutMs: number;
}

export interface TuningOverrides {
  weights?: Partial<Tuning["weights"]>;
  features?: Partial<Tuning["features"]>;
  rerankBudgetMs?: number;
  semanticTimeoutMs?: number;
}

export const DEFAULT_TUNING: Tuning = {
  weights: { ...WEIGHTS },
  features: { ...FEATURES },
  rerankBudgetMs: SEMANTIC.rerankBudgetMs,
  semanticTimeoutMs: SEMANTIC.timeoutMs,
};

export function withOverrides(overrides: TuningOverrides | null): Tuning {
  if (!overrides) return DEFAULT_TUNING;
  const tuning = {
    weights: { ...DEFAULT_TUNING.weights, ...overrides.weights },
    features: { ...DEFAULT_TUNING.features, ...overrides.features },
    rerankBudgetMs: overrides.rerankBudgetMs ?? DEFAULT_TUNING.rerankBudgetMs,
    semanticTimeoutMs: overrides.semanticTimeoutMs ?? DEFAULT_TUNING.semanticTimeoutMs,
  };
  if (!Number.isInteger(tuning.features.trackRecordUsedByCap) || tuning.features.trackRecordUsedByCap <= 0) {
    throw new RangeError("trackRecordUsedByCap must be a positive integer");
  }
  if (!Number.isFinite(tuning.features.trackRecordMaxBonus) || tuning.features.trackRecordMaxBonus < 0 || tuning.features.trackRecordMaxBonus > MAX_TRACK_RECORD_BONUS) {
    throw new RangeError("trackRecordMaxBonus must be a finite number between 0 and 0.03");
  }
  return tuning;
}
