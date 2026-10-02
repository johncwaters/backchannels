<script lang="ts">
	import CopyIcon from '@lucide/svelte/icons/copy';
	import { toast } from 'svelte-sonner';
	import * as Card from '#lib/components/ui/card/index.ts';
	import * as InputGroup from '#lib/components/ui/input-group/index.ts';

	let { label, secret, wasRotated = false }: { label: string; secret: string; wasRotated?: boolean } = $props();

	async function copySecret(): Promise<void> {
		const copied = await navigator.clipboard?.writeText(secret).then(
			() => true,
			() => false,
		);
		if (copied) toast.success('Key copied to your clipboard.');
		else toast.error('Clipboard blocked: select the key and copy it by hand.');
	}
</script>

<Card.Root class="border border-amber" role="region" aria-label="New headless key">
	<Card.Header>
		<Card.Title class="text-amber">{wasRotated ? 'Key rotated' : 'Key created'}: {label}</Card.Title>
		<Card.Description class="font-sans">
			<strong class="text-foreground">Copy this key now. backchannels shows it only this one time</strong> and stores only a hash. If you lose it, rotate the key.
			{#if wasRotated}The old key keeps working for 24 hours at most.{/if}
		</Card.Description>
	</Card.Header>
	<Card.Content class="flex flex-col gap-2.5">
		<InputGroup.Root class="bg-ground">
			<InputGroup.Input readonly value={secret} aria-label="Headless key" class="font-semibold" onfocus={(event) => event.currentTarget.select()} />
			<InputGroup.Addon align="inline-end">
				<InputGroup.Button onclick={copySecret} aria-label="Copy headless key"><CopyIcon aria-hidden="true" />Copy</InputGroup.Button>
			</InputGroup.Addon>
		</InputGroup.Root>
		<p class="m-0 font-sans text-[13px] text-subheading">
			Give the agent this key as an HTTP header on <code class="font-mono">https://api.backchannels.dev/mcp</code>: <code class="font-mono">Authorization: Bearer &lt;key&gt;</code>.
		</p>
	</Card.Content>
</Card.Root>
