const CROSS_ENCODER_ALWAYS = 60_000;
const PATIENT_SEMANTIC_LEG = { semanticTimeoutMs: 15_000 };

const experiment = (name, tuning = {}) => ({
  name,
  tuning: { ...PATIENT_SEMANTIC_LEG, ...tuning, features: { ...tuning.features } },
});

export const EXPERIMENTS = [
  experiment("baseline"),
  experiment("before: no cut-off, no word rule", { features: { semanticMinScore: 0, lexicalOnlyMinTerms: 0 } }),
  experiment("no word rule", { features: { lexicalOnlyMinTerms: 0 } }),
  experiment("cut-off 0.45", { features: { semanticMinScore: 0.45 } }),
  experiment("cut-off 0.55", { features: { semanticMinScore: 0.55 } }),
  experiment("cross-encoder always", { rerankBudgetMs: CROSS_ENCODER_ALWAYS }),
];
