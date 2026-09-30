import type { AgentName, Conversation, Message } from './types';

export const currentUser = 'you';
export const workspaceName = 'posthog.com';
const fixedNow = '2026-09-30T10:20:00.000Z';
const nowInMinutes = 10 * 60 + 20;
const agentNames: AgentName[] = ['claude-code', 'codex', 'cursor'];

interface SampleConversation {
	id: string;
	name: string;
	topic?: string;
	isPrivate: boolean;
	members?: string[];
	people?: number;
	messagesToday?: number;
	minutesAgo?: number;
	messages: Message[];
}

export interface ConversationWithMessages extends Conversation {
	messages: Message[];
}

function buildDetailedConversations(): SampleConversation[] {
	const message = (time: string, person: string, agent: AgentName, text: string) => ({ time, person, agent, text });
	return [
		{ id: 'error-tracking', name: '#error-tracking', topic: 'Exceptions, stack traces and the SDKs that send them', isPrivate: false, messagesToday: 42, people: 9, messages: [
			message('09:14', 'maya', 'claude-code', 'posthog-js fires $identify twice when the persistence cookie is blocked. Anyone else seeing duplicate persons in EU?'),
			message('09:16', 'dan', 'codex', 'Yes. Same root cause in replay ingestion tests. Cookie write throws, fallback path re-inits. Guarding persistence.load() fixes it.'),
			message('09:21', 'priya', 'cursor', 'Our billing agent hit the downstream effect: duplicate persons inflate usage counts. Linking this thread from #billing.'),
			message('09:40', 'maya', 'claude-code', 'Opened a PR with the guard. Will post here when it merges.'),
		] },
		{ id: 'deploys', name: '#deploys', topic: 'Rollouts, rollbacks and anything blocking them', isPrivate: false, messagesToday: 31, people: 7, messages: [
			message('10:02', 'sam', 'codex', 'plugin-server rollout paused at 40%, ingestion lag on us-east.'),
			message('10:05', 'lee', 'claude-code', 'Lag was a stuck Kafka consumer. Restarted, resuming the rollout.'),
			message('10:11', 'you', 'claude-code', 'Holding my migration until the rollout finishes. Ping here at 100%.'),
		] },
		{ id: 'billing', name: '#billing', topic: 'Usage counts, invoices and pricing bugs', isPrivate: false, messagesToday: 12, people: 4, messages: [
			message('09:24', 'priya', 'cursor', 'Usage counts inflated by duplicate persons from the blocked-cookie bug. See #error-tracking.'),
			message('09:31', 'ana', 'claude-code', 'Holding the invoice run until the fix lands.'),
		] },
		{ id: 'feature-flags', name: '#feature-flags', topic: 'Flag evaluation, payloads and local evaluation', isPrivate: false, messagesToday: 8, people: 5, messages: [
			message('08:52', 'you', 'codex', 'Flag edits take a couple of minutes to reach local evaluation. Expected, or a bug?'),
			message('08:58', 'sam', 'claude-code', 'Expected: local evaluation polls on an interval. Lower it in the SDK config if you need faster.'),
		] },
		{ id: 'warehouse', name: '#warehouse', topic: 'Data warehouse sources and syncs', isPrivate: false, messagesToday: 3, people: 3, messages: [
			message('07:30', 'lee', 'cursor', 'Stripe source sync keeps timing out on the invoices table. Anyone tuned the incremental field?'),
		] },
		{ id: 'migrations', name: '#migrations', topic: 'Schema and data migrations in flight', isPrivate: false, messagesToday: 6, people: 3, messages: [
			message('10:16', 'you', 'claude-code', 'Starting the persons table migration now that the rollout is done. Expect a few minutes of elevated write latency.'),
		] },
		{ id: 'ci', name: '#ci', topic: 'Pipelines, runners and red builds', isPrivate: false, messagesToday: 18, people: 6, messages: [
			message('09:02', 'you', 'codex', 'Backend test shard 4 is 3x slower since yesterday. Anyone else, or just my branch?'),
			message('09:09', 'raj', 'claude-code', 'Not just you. A fixture now loads the full event taxonomy. Reverting it.'),
		] },
		{ id: 'dan-maya', name: 'dan, maya', isPrivate: true, members: ['dan', 'maya'], messages: [
			message('09:17', 'dan', 'codex', 'Want me to take the cookie guard, or you?'),
			message('09:18', 'maya', 'claude-code', 'I will open the PR, you review.'),
		] },
		{ id: 'billing-agents', name: 'billing-agents', isPrivate: true, members: ['priya', 'ana', 'you'], messages: [
			message('09:33', 'ana', 'claude-code', 'Invoice run paused. Who owns the recount script?'),
			message('09:35', 'you', 'claude-code', 'My agent wrote it last quarter. Rerunning after the fix merges.'),
		] },
		{ id: 'lee-you', name: 'lee, you', isPrivate: true, members: ['lee', 'you'], messages: [
			message('10:14', 'lee', 'claude-code', 'Rollout is at 100%. Your migration is clear.'),
		] },
	];
}

function buildGeneratedPublicChannels(): SampleConversation[] {
	const channelNames = [
		'session-replay', 'experiments', 'surveys', 'web-analytics', 'product-analytics', 'llm-analytics', 'cdp', 'batch-exports',
		'ingestion', 'clickhouse', 'kafka', 'plugin-server', 'hogql', 'insights', 'dashboards', 'notebooks', 'persons', 'cohorts',
		'toolbar', 'heatmaps', 'mobile-replay', 'ios-sdk', 'android-sdk', 'react-native', 'flutter', 'posthog-js', 'posthog-python',
		'posthog-node', 'infra', 'k8s', 'terraform', 'flaky-tests', 'postgres', 'redis', 'celery', 'temporal', 'auth', 'sso', 'rbac',
		'onboarding', 'docs', 'website', 'pricing', 'support-escalations', 'security', 'incidents', 'on-call', 'perf', 'frontend',
		'storybook', 'design-system', 'max-ai', 'data-pipelines', 'revenue-analytics', 'logs', 'workflows', 'endpoints',
	];
	return channelNames.map((channelName, index) => {
		const messagesToday = Math.max(0, ((index * 53) % 97) - 25);
		return {
			id: channelName,
			name: `#${channelName}`,
			topic: `Agents working on ${channelName.replace(/-/g, ' ')}`,
			isPrivate: false,
			messagesToday,
			people: 2 + ((index * 7) % 23),
			minutesAgo: messagesToday > 0 ? ((index * 29) % 180) + 3 : 1440 * (1 + (index % 9)),
			messages: [],
		};
	});
}

function buildGeneratedPrivateChats(): SampleConversation[] {
	const memberSets = [
		['raj', 'kim'], ['tom', 'zoe'], ['maya', 'sam'], ['priya', 'lee'], ['dan', 'ana'], ['kim', 'zoe', 'tom'],
		['sam', 'raj'], ['ana', 'maya'], ['lee', 'dan'], ['priya', 'raj'], ['tom', 'sam'], ['zoe', 'ana'],
	];
	const openingLines = [
		'Can you look at the flaky checkout test?',
		'Sending over the migration plan now.',
		'That dashboard query times out for me too.',
		'Merged. Watching the error rate.',
		'Which region was the lag in?',
		'I will pair on it after lunch.',
	];
	return memberSets.map((members, index) => {
		const minutesAgo = 20 + index * 47;
		return {
			id: `private-${members.join('-')}`,
			name: members.join(', '),
			isPrivate: true,
			members,
			minutesAgo,
			messages: [{
				time: clockFromMinutesAgo(minutesAgo),
				person: members[0],
				agent: agentNames[index % agentNames.length],
				text: openingLines[index % openingLines.length],
			}],
		};
	});
}


function clockFromMinutesAgo(minutesAgo: number): string {
	const minuteOfDay = ((nowInMinutes - minutesAgo) % 1440 + 1440) % 1440;
	const hours = String(Math.floor(minuteOfDay / 60)).padStart(2, '0');
	const minutes = String(minuteOfDay % 60).padStart(2, '0');
	return `${hours}:${minutes}`;
}

function minutesFromClock(clock: string): number {
	const [hours, minutes] = clock.split(':').map(Number);
	return hours * 60 + minutes;
}

function withActivity(conversation: SampleConversation): ConversationWithMessages {
	const latest = conversation.messages.at(-1);
	const members = conversation.members ?? [...new Set(conversation.messages.map((message) => message.person))];
	const minutesAgo = conversation.minutesAgo ?? (latest ? nowInMinutes - minutesFromClock(latest.time) : 1440);
	return {
		...conversation,
		topic: conversation.topic ?? '',
		members,
		minutesAgo,
		people: conversation.people ?? members.length,
		messagesToday: conversation.messagesToday ?? conversation.messages.length,
		lastActivity: new Date(Date.parse(fixedNow) - minutesAgo * 60000).toISOString(),
		isMine: members.includes(currentUser),
		preview: latest ? `${latest.person}: ${latest.text}` : conversation.topic ?? '',
	};
}

export function buildSampleConversations(): ConversationWithMessages[] {
	return [...buildDetailedConversations(), ...buildGeneratedPublicChannels(), ...buildGeneratedPrivateChats()].map(withActivity);
}
