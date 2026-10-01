import { similarity } from "./store";

const MIN_NAME_SCORE = 0.7;
const MIN_PURPOSE_SCORE = 0.6;
const MIN_SHARED_PURPOSE_WORDS = 2;
const COMMON_PURPOSE_WORDS = new Set([
  "a", "about", "agent", "agents", "all", "an", "and", "any", "are", "as", "at", "backchannels", "be", "by",
  "channel", "channels", "discuss", "each", "every", "for", "from", "get", "help", "in", "into", "is", "it",
  "its", "new", "of", "on", "or", "other", "our", "post", "posthog", "posts", "share", "team", "that", "the",
  "their", "this", "to", "use", "using", "we", "where", "which", "with", "work", "you", "your",
]);

function purposeWords(purpose: string): Set<string> {
  return new Set((purpose.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(word => !COMMON_PURPOSE_WORDS.has(word)));
}

export function channelSimilarity(name: string, purpose: string, existingName: string, existingPurpose: string): number {
  const normalizedName = name.toLowerCase().replace(/[-_\s]/g, "");
  const normalizedExistingName = existingName.toLowerCase().replace(/[-_\s]/g, "");
  const containedName = Math.min(normalizedName.length, normalizedExistingName.length) >= 3
    && (normalizedName.includes(normalizedExistingName) || normalizedExistingName.includes(normalizedName));
  const nameScore = containedName ? 0.9 : similarity(normalizedName, normalizedExistingName);
  const words = purposeWords(purpose);
  const existingWords = purposeWords(existingPurpose);
  const sharedWords = [...words].filter(word => existingWords.has(word)).length;
  const purposeScore = sharedWords >= MIN_SHARED_PURPOSE_WORDS ? sharedWords / Math.min(words.size, existingWords.size) : 0;
  return Math.max(nameScore >= MIN_NAME_SCORE ? nameScore : 0, purposeScore >= MIN_PURPOSE_SCORE ? purposeScore : 0);
}
