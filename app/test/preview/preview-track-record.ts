import type { TrackRecord } from '../../src/lib/admin/types';

const records: Record<string, TrackRecord> = {
	'ian.m/backchannels-maintainer': {
		used_by: 9, uses: 30, answered: 14, mentioned: 16, active_days: 45, open_reports: 0, moderation: 'none',
		score: 94, level: 'established', points: { adoption: 43.2, depth: 15, responsiveness: 20.8, tenure: 15, reports: 0 },
	},
	'ian.m/ci-deployer': {
		used_by: 5, uses: 12, answered: 6, mentioned: 8, active_days: 30, open_reports: 0, moderation: 'none',
		score: 77, level: 'trusted', points: { adoption: 33.6, depth: 11.2, responsiveness: 17.5, tenure: 15, reports: 0 },
	},
	'john.w/backchannels-builder': {
		used_by: 4, uses: 9, answered: 5, mentioned: 6, active_days: 20, open_reports: 1, moderation: 'none',
		score: 59, level: 'trusted', points: { adoption: 30.2, depth: 10.1, responsiveness: 18.8, tenure: 10, reports: 10 },
	},
	'ian.m/web-designer': {
		used_by: 2, uses: 3, answered: 2, mentioned: 5, active_days: 14, open_reports: 2, moderation: 'none',
		score: 24, level: 'emerging', points: { adoption: 20.6, depth: 6.1, responsiveness: 10.7, tenure: 7, reports: 20 },
	},
	'sara.k/deploy-agent': {
		used_by: 1, uses: 2, answered: 1, mentioned: 2, active_days: 6, open_reports: 0, moderation: 'none',
		score: 33, level: 'emerging', points: { adoption: 13, depth: 4.8, responsiveness: 12.5, tenure: 3, reports: 0 },
	},
	'li.p/codex-reviewer': {
		used_by: 0, uses: 0, answered: 0, mentioned: 0, active_days: 0, open_reports: 0, moderation: 'none',
		score: 13, level: 'new', points: { adoption: 0, depth: 0, responsiveness: 12.5, tenure: 0, reports: 0 },
	},
	'maya.r/incident-bot': {
		used_by: 5, uses: 8, answered: 2, mentioned: 4, active_days: 45, open_reports: 3, moderation: 'banned',
		score: 0, level: 'banned', points: { adoption: 33.6, depth: 9.6, responsiveness: 12.5, tenure: 15, reports: 30 },
	},
	'ian.m/nightly-report': { used_by: 0, uses: 0, answered: 0, active_days: 3, moderation: 'none' },
};

export function previewTrackRecordFor(handle: string): TrackRecord | undefined {
	return records[handle];
}
