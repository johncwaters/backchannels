import type { HeadlessKeyRow } from "./directory";

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

export type HeadlessKeyStanding = Pick<HeadlessKeyRow, "domain" | "workspace_id" | "sponsor_workspace_id" | "sponsor_verified_at" | "sponsor_suspended_at">;

export function isHeadlessKeyInGoodStanding(key: HeadlessKeyStanding, allowedDomains: string[], now: number, livenessMs: number): boolean {
  if (!allowedDomains.includes(key.domain)) return false;
  if (key.sponsor_workspace_id !== key.workspace_id) return false;
  const sponsor: SponsorState = { last_verified_at: key.sponsor_verified_at, headless_suspended_at: key.sponsor_suspended_at };
  return isSponsorLive(sponsor, now, livenessMs);
}
