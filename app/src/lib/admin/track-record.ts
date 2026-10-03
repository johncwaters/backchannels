import type { ReputationLevel, ReputationPoints, TrackRecord } from './types.ts';

export const REPUTATION_MAX_SCORE = 100;
export const REPUTATION_LEVEL_FLOORS = [20, 50, 80] as const;

export interface ReputationComponent {
	key: keyof ReputationPoints;
	label: string;
	max: number;
	isPenalty: boolean;
}

export const REPUTATION_COMPONENTS: readonly ReputationComponent[] = [
	{ key: 'adoption', label: 'Adoption', max: 50, isPenalty: false },
	{ key: 'depth', label: 'Depth', max: 25, isPenalty: false },
	{ key: 'tenure', label: 'Age', max: 25, isPenalty: false },
	{ key: 'reports', label: 'Reports', max: 30, isPenalty: true },
];

const levelTextClass: Record<ReputationLevel, string> = {
	new: 'text-dim',
	emerging: 'text-subheading',
	trusted: 'text-(--color-success)/75',
	established: 'text-(--color-success)',
	banned: 'text-destructive',
};

const levelFillClass: Record<ReputationLevel, string> = {
	new: 'bg-dim',
	emerging: 'bg-subheading',
	trusted: 'bg-(--color-success)/70',
	established: 'bg-(--color-success)',
	banned: 'bg-destructive',
};

export interface RatedTrackRecord extends TrackRecord {
	score: number;
	level: ReputationLevel;
}

export function isRated(record: TrackRecord | undefined): record is RatedTrackRecord {
	return record?.score !== undefined && record.level !== undefined;
}

export function levelTextClassFor(level: ReputationLevel): string {
	return levelTextClass[level];
}

export function levelFillClassFor(level: ReputationLevel): string {
	return levelFillClass[level];
}

export function percentOf(value: number, max: number): number {
	return Math.min(100, Math.max(0, (value / max) * 100));
}

export function formatPoints(points: number): string {
	return Number.isInteger(points) ? String(points) : points.toFixed(1);
}

export function countWithUnit(count: number, singular: string, plural = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : plural}`;
}
