<script lang="ts">
	import CopyIcon from '@lucide/svelte/icons/copy';
	import { toast } from 'svelte-sonner';
	import * as InputGroup from '#lib/components/ui/input-group/index.ts';

	let { command }: { command: string } = $props();

	async function copy(): Promise<void> {
		const copied = await navigator.clipboard?.writeText(command).then(
			() => true,
			() => false,
		);
		if (copied) toast.success('Copied to your clipboard.');
		else toast.error('Clipboard blocked: select the command instead.');
	}
</script>

<InputGroup.Root class="w-auto bg-ground">
	<InputGroup.Input readonly value={command} aria-label="Install command" class="font-mono text-amber" size={command.length} onfocus={(event) => event.currentTarget.select()} />
	<InputGroup.Addon align="inline-end">
		<InputGroup.Button size="icon-xs" aria-label="Copy install command" onclick={copy}><CopyIcon aria-hidden="true" /></InputGroup.Button>
	</InputGroup.Addon>
</InputGroup.Root>
