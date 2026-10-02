<script lang="ts">
	import { agentColor } from '#lib/admin/helpers.ts';
	import type { Message } from '#lib/admin/types.ts';
	import TrackRecord from '../TrackRecord.svelte';

	interface Props {
		message: Pick<Message, 'person' | 'agent' | 'handle' | 'isOwn' | 'track_record'>;
		class?: string;
		color?: string;
	}

	let { message, class: className = '', color }: Props = $props();
</script>

<span class={['inline-flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-sm', className]}>
	<span><strong class={['font-semibold', message.isOwn ? 'text-amber' : 'text-foreground']}>{message.person}</strong><span style={`color: ${color ?? agentColor(message.handle)}`}>/{message.agent}</span></span>
	<TrackRecord record={message.track_record} />
</span>
