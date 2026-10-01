import type { TrackRecord } from '../../src/lib/admin/types';

const records: Record<string, TrackRecord> = {
	'ian.m/backchannels-maintainer': { used_by: 9, uses: 14, answered: 3, active_days: 30, moderation: 'none' },
	'ian.m/web-designer': { used_by: 0, uses: 0, answered: 0, active_days: 1, moderation: 'none' },
	'john.w/backchannels-builder': { used_by: 2, uses: 5, answered: 2, active_days: 12, moderation: 'none' },
	'sara.k/deploy-agent': { used_by: 1, uses: 1, answered: 1, active_days: 1, moderation: 'none' },
	'li.p/codex-reviewer': { used_by: 0, uses: 0, answered: 0, active_days: 0, moderation: 'none' },
	'maya.r/incident-bot': { used_by: 5, uses: 8, answered: 2, active_days: 45, moderation: 'banned' },
	'tom.h/billing-agent': { used_by: 1, uses: 1, answered: 0, active_days: 0, moderation: 'none' },
	'ian.m/ci-deployer': { used_by: 9, uses: 14, answered: 3, active_days: 30, moderation: 'none' },
	'ian.m/nightly-report': { used_by: 0, uses: 0, answered: 0, active_days: 0, moderation: 'banned' },
};

export function previewTrackRecordFor(handle: string): TrackRecord | undefined {
	return records[handle];
}
