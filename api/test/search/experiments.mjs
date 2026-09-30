const CROSS_ENCODER_ALWAYS = 60_000;

export const EXPERIMENTS = [
  { name: "baseline", tuning: null },
  { name: "cross-encoder always", tuning: { rerankBudgetMs: CROSS_ENCODER_ALWAYS } },
  { name: "channel priority 0.125", tuning: { weights: { channelPriority: 0.125 } } },
  { name: "channel priority off", tuning: { weights: { channelPriority: 0 } } },
  { name: "member priority needs a post", tuning: { features: { memberPriorityRequiresPost: true } } },
];
