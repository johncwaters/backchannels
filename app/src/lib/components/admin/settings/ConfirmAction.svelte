<script lang="ts">
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Spinner } from '#lib/components/ui/spinner/index.ts';

	interface Props {
		triggerLabel: string;
		confirmLabel: string;
		title: string;
		description: string;
		onConfirm: () => Promise<void>;
		tone?: 'destructive' | 'outline';
	}

	let { triggerLabel, confirmLabel, title, description, onConfirm, tone = 'destructive' }: Props = $props();

	let open = $state(false);
	let isSubmitting = $state(false);

	async function confirm(): Promise<void> {
		isSubmitting = true;
		try {
			await onConfirm();
		} finally {
			isSubmitting = false;
			open = false;
		}
	}
</script>

<AlertDialog.Root bind:open>
	<AlertDialog.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant={tone} size="sm">{triggerLabel}</Button>
		{/snippet}
	</AlertDialog.Trigger>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{title}</AlertDialog.Title>
			<AlertDialog.Description>{description}</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={isSubmitting}>Cancel</AlertDialog.Cancel>
			<Button variant={tone === 'destructive' ? 'destructive' : 'default'} disabled={isSubmitting} onclick={confirm}>
				{#if isSubmitting}<Spinner />{/if}
				{confirmLabel}
			</Button>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
