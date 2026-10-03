import type { TrackRecord } from "./trackRecord";

export const REPUTATION_WEIGHTS = { adoption: 50, depth: 25, tenure: 25 } as const;
export const REPUTATION_SATURATION = { usedBy: 10, uses: 30, activeDays: 30 } as const;
export const REPUTATION_REPORT_PENALTY = { perOpenReport: 10, max: 30 } as const;
export const REPUTATION_SCORE_RANGE = { min: 0, max: 100 } as const;
export const REPUTATION_LEVEL_FLOORS = { emerging: 20, trusted: 50, established: 80 } as const;
const POINTS_DECIMALS = 10;

export type ReputationLevel = "new" | "emerging" | "trusted" | "established" | "banned";

export interface ReputationPoints {
  adoption: number;
  depth: number;
  tenure: number;
  reports: number;
}

export interface Reputation {
  score: number;
  level: ReputationLevel;
  points: ReputationPoints;
}

type ReputationInputs = Pick<TrackRecord, "used_by" | "uses" | "active_days" | "open_reports" | "moderation">;

function logSaturation(count: number, saturatesAt: number): number {
  return Math.min(1, Math.log1p(Math.max(0, count)) / Math.log1p(saturatesAt));
}

function roundPoints(points: number): number {
  return Math.round(points * POINTS_DECIMALS) / POINTS_DECIMALS;
}

function clampScore(score: number): number {
  return Math.min(REPUTATION_SCORE_RANGE.max, Math.max(REPUTATION_SCORE_RANGE.min, score));
}

export function levelOf(score: number): Exclude<ReputationLevel, "banned"> {
  if (score >= REPUTATION_LEVEL_FLOORS.established) return "established";
  if (score >= REPUTATION_LEVEL_FLOORS.trusted) return "trusted";
  if (score >= REPUTATION_LEVEL_FLOORS.emerging) return "emerging";
  return "new";
}

export function reputationOf(record: ReputationInputs): Reputation {
  const adoption = REPUTATION_WEIGHTS.adoption * logSaturation(record.used_by, REPUTATION_SATURATION.usedBy);
  const depth = REPUTATION_WEIGHTS.depth * logSaturation(record.uses, REPUTATION_SATURATION.uses);
  const tenure = REPUTATION_WEIGHTS.tenure * Math.min(1, Math.max(0, record.active_days) / REPUTATION_SATURATION.activeDays);
  const reports = Math.min(REPUTATION_REPORT_PENALTY.max, REPUTATION_REPORT_PENALTY.perOpenReport * record.open_reports);
  const points = {
    adoption: roundPoints(adoption),
    depth: roundPoints(depth),
    tenure: roundPoints(tenure),
    reports: roundPoints(reports),
  };
  if (record.moderation === "banned") return { score: REPUTATION_SCORE_RANGE.min, level: "banned", points };
  const score = Math.round(clampScore(adoption + depth + tenure - reports));
  return { score, level: levelOf(score), points };
}
