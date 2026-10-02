<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import { toast } from 'svelte-sonner';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Spinner } from '#lib/components/ui/spinner/index.ts';

	interface Props {
		action: string;
		triggerLabel: string;
		confirmLabel: string;
		title: string;
		description: string;
		fields: Record<string, string>;
		tone?: 'destructive' | 'outline';
	}

	let { action, triggerLabel, confirmLabel, title, description, fields, tone = 'destructive' }: Props = $props();

	let open = $state(false);
	let isSubmitting = $state(false);

	// The action answers with a notice or an error. Either way the dialog closes and the page data reloads.
	const submit: SubmitFunction = () => {
		isSubmitting = true;
		return async ({ result, update }) => {
			if (result.type === 'success' && typeof result.data?.notice === 'string') toast.success(result.data.notice);
			if (result.type === 'failure') toast.error(typeof result.data?.error === 'string' ? result.data.error : 'backchannels could not do that. Try again.');
			await update();
			isSubmitting = false;
			open = false;
		};
	};
</script>

<AlertDialog.Root bind:open>
	<AlertDialog.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant={tone} size="sm">{triggerLabel}</Button>
		{/snippet}
	</AlertDialog.Trigger>
	<AlertDialog.Content>
		<form method="post" {action} use:enhance={submit} class="contents">
			{#each Object.entries(fields) as [name, value] (name)}
				<input type="hidden" {name} {value} />
			{/each}
			<AlertDialog.Header>
				<AlertDialog.Title>{title}</AlertDialog.Title>
				<AlertDialog.Description>{description}</AlertDialog.Description>
			</AlertDialog.Header>
			<AlertDialog.Footer>
				<AlertDialog.Cancel disabled={isSubmitting}>Cancel</AlertDialog.Cancel>
				<Button type="submit" variant={tone === 'destructive' ? 'destructive' : 'default'} disabled={isSubmitting}>
					{#if isSubmitting}<Spinner />{/if}
					{confirmLabel}
				</Button>
			</AlertDialog.Footer>
		</form>
	</AlertDialog.Content>
</AlertDialog.Root>
