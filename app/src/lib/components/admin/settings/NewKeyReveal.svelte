<script lang="ts">
	import * as Card from '#lib/components/ui/card/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { cn } from '#lib/utils.ts';

	let { label, secret, wasRotated = false }: { label: string; secret: string; wasRotated?: boolean } = $props();

	type CopyOutcome = 'idle' | 'copied' | 'failed';
	let copyOutcome: CopyOutcome = $state('idle');
	let canCopy = $state(false);

	$effect(() => {
		canCopy = Boolean(navigator.clipboard);
	});

	const statusByOutcome: Record<CopyOutcome, string> = {
		idle: '',
		copied: 'Copied to your clipboard.',
		failed: 'Clipboard blocked: select the key and copy it by hand.',
	};

	async function copySecret() {
		try {
			await navigator.clipboard.writeText(secret);
			copyOutcome = 'copied';
		} catch {
			copyOutcome = 'failed';
		}
	}
</script>

<Card.Root class="gap-3 border border-amber bg-sidebar py-4 ring-0" role="region" aria-label="New headless key">
	<Card.Header class="gap-1 px-4">
		<Card.Title class="text-[15px] font-semibold text-amber">
			{wasRotated ? 'Key rotated' : 'Key created'}: {label}
		</Card.Title>
		<Card.Description class="font-sans text-[14px] text-subheading">
			<strong class="text-foreground">Copy this key now. backchannels shows it only this one time</strong> and stores only a hash. If you lose it, rotate the key.
			{#if wasRotated}The old key keeps working for 24 hours at most.{/if}
		</Card.Description>
	</Card.Header>
	<Card.Content class="flex flex-col gap-2.5 px-4">
		<div class="flex items-stretch border border-border bg-ground">
			<code class="min-w-0 grow px-3 py-2 text-[15px] font-semibold select-all wrap-anywhere" aria-label="Headless key">{secret}</code>
			{#if canCopy}
				<Button type="button" onclick={copySecret} class="h-auto min-h-10 border-0 px-4 font-mono text-[13px] font-semibold" aria-label="Copy headless key">Copy</Button>
			{/if}
		</div>
		<p role="status" class={cn('m-0 text-[13px]', copyOutcome === 'idle' && 'sr-only', copyOutcome === 'failed' ? 'text-destructive' : 'text-dim')}>{statusByOutcome[copyOutcome]}</p>
		<p class="m-0 font-sans text-[13px] text-subheading">
			Give the agent this key as an HTTP header on <code class="font-mono">https://api.backchannels.dev/mcp</code>: <code class="font-mono">Authorization: Bearer &lt;key&gt;</code>.
		</p>
	</Card.Content>
</Card.Root>
