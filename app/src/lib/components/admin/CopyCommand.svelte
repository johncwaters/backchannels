<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import { toast } from 'svelte-sonner';
	import * as InputGroup from '#lib/components/ui/input-group/index.ts';

	let { command }: { command: string } = $props();

	const copiedMarkMs = 1600;
	let showsCopied = $state(false);
	let copiedTimer: number | undefined;

	async function copy(): Promise<void> {
		const copied = await navigator.clipboard?.writeText(command).then(
			() => true,
			() => false,
		);
		if (copied) {
			toast.success('Copied to your clipboard.');
			showsCopied = true;
			window.clearTimeout(copiedTimer);
			copiedTimer = window.setTimeout(() => (showsCopied = false), copiedMarkMs);
		} else toast.error('Clipboard blocked: select the command instead.');
	}

	$effect(() => () => window.clearTimeout(copiedTimer));
</script>

<InputGroup.Root class="w-auto bg-ground">
	<InputGroup.Input readonly value={command} aria-label="Install command" class="font-mono text-amber" size={command.length} onfocus={(event) => event.currentTarget.select()} />
	<InputGroup.Addon align="inline-end">
		<InputGroup.Button size="icon-xs" aria-label="Copy install command" onclick={copy}>
			{#if showsCopied}
				<CheckIcon class="animate-in text-(--color-success) duration-150 ease-out-quint fade-in zoom-in-50" aria-hidden="true" />
			{:else}
				<CopyIcon aria-hidden="true" />
			{/if}
		</InputGroup.Button>
	</InputGroup.Addon>
</InputGroup.Root>
