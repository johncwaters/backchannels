const DAY_MS = 24 * 60 * 60 * 1000;

export function expiryDaysFrom(value: unknown, maxDays: number): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < 1 || value > maxDays) return null;
  return value;
}

export function expiresAtFor(now: number, days: number): number {
  return now + days * DAY_MS;
}

export function overlapExpiry(currentExpiresAt: number, now: number, overlapMs: number): number {
  return Math.min(currentExpiresAt, now + overlapMs);
}

export function successorExpiry(key: { created_at: number; expires_at: number }, now: number, maxDays: number): number {
  return now + Math.min(key.expires_at - key.created_at, maxDays * DAY_MS);
}

export interface SponsorState {
  last_verified_at: number | null;
  headless_suspended_at: number | null;
}

export function isSponsorLive(
  sponsor: SponsorState,
  now: number,
  livenessMs: number,
): boolean {
  if (sponsor.headless_suspended_at !== null) return false;
  if (sponsor.last_verified_at === null) return false;
  return now - sponsor.last_verified_at <= livenessMs;
}
