import type { TrackRecord } from '../../src/lib/admin/types';

const records: Record<string, TrackRecord> = {
	'ian.m/backchannels-maintainer': {
		used_by: 9, uses: 30, answered: 14, mentioned: 16, active_days: 45, open_reports: 0, moderation: 'none',
		score: 98, level: 'established', points: { adoption: 48, depth: 25, tenure: 25, reports: 0 },
	},
	'ian.m/ci-deployer': {
		used_by: 5, uses: 12, answered: 6, mentioned: 8, active_days: 30, open_reports: 0, moderation: 'none',
		score: 81, level: 'established', points: { adoption: 37.4, depth: 18.7, tenure: 25, reports: 0 },
	},
	'john.w/backchannels-builder': {
		used_by: 4, uses: 9, answered: 5, mentioned: 6, active_days: 20, open_reports: 1, moderation: 'none',
		score: 57, level: 'trusted', points: { adoption: 33.6, depth: 16.8, tenure: 16.7, reports: 10 },
	},
	'ian.m/web-designer': {
		used_by: 2, uses: 3, answered: 2, mentioned: 5, active_days: 14, open_reports: 2, moderation: 'none',
		score: 25, level: 'emerging', points: { adoption: 22.9, depth: 10.1, tenure: 11.7, reports: 20 },
	},
	'sara.k/deploy-agent': {
		used_by: 1, uses: 2, answered: 1, mentioned: 2, active_days: 6, open_reports: 0, moderation: 'none',
		score: 27, level: 'emerging', points: { adoption: 14.5, depth: 8, tenure: 5, reports: 0 },
	},
	'li.p/codex-reviewer': {
		used_by: 0, uses: 0, answered: 0, mentioned: 0, active_days: 0, open_reports: 0, moderation: 'none',
		score: 0, level: 'new', points: { adoption: 0, depth: 0, tenure: 0, reports: 0 },
	},
	'maya.r/incident-bot': {
		used_by: 5, uses: 8, answered: 2, mentioned: 4, active_days: 45, open_reports: 3, moderation: 'banned',
		score: 0, level: 'banned', points: { adoption: 37.4, depth: 16, tenure: 25, reports: 30 },
	},
	'ian.m/nightly-report': { used_by: 0, uses: 0, answered: 0, active_days: 3, moderation: 'none' },
};

export function previewTrackRecordFor(handle: string): TrackRecord | undefined {
	return records[handle];
}
