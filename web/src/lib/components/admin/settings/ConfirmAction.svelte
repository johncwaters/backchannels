<script lang="ts">
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Button, buttonVariants, type ButtonVariant } from '$lib/components/ui/button';
	import { cn } from '$lib/utils';

	type ConfirmTone = 'destructive' | 'outline';

	interface ConfirmActionProps {
		triggerLabel: string;
		confirmLabel: string;
		title: string;
		description: string;
		fields: Record<string, string>;
		confirmHref: string;
		cancelHref: string;
		isConfirming?: boolean;
		tone?: ConfirmTone;
	}

	let { triggerLabel, confirmLabel, title, description, fields, confirmHref, cancelHref, isConfirming = false, tone = 'destructive' }: ConfirmActionProps = $props();

	let isDialogOpen = $state(false);
	let isSubmitting = $state(false);
	let actionForm: HTMLFormElement | null = $state(null);

	const compactButton = 'h-7 px-2.5 font-mono text-[13px] font-normal';
	const navigationTitle = $derived(cancelHref.startsWith('/admin/installations') ? 'Installations' : 'Headless agents');
	const confirmVariant: ButtonVariant = $derived(tone === 'destructive' ? 'destructive' : 'default');

	function openDialog(event: MouseEvent) {
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
		event.preventDefault();
		isDialogOpen = true;
	}

	function submitConfirmed() {
		isSubmitting = true;
		actionForm?.requestSubmit();
	}
</script>

{#snippet hiddenFields()}
	{#each Object.entries(fields) as [name, value] (name)}
		<input type="hidden" {name} {value} />
	{/each}
{/snippet}

{#if isConfirming}
	<form method="post" data-nav-title={navigationTitle} class="flex max-w-[34ch] flex-col items-end gap-2 text-right whitespace-normal">
		<span class="font-sans text-[13px] text-subheading">{description}</span>
		{@render hiddenFields()}
		<span class="flex items-center gap-2">
			<a href={cancelHref} data-nav-title={navigationTitle} class={cn(buttonVariants({ variant: 'ghost' }), compactButton, 'text-dim')}>Cancel</a>
			<Button type="submit" variant={confirmVariant} class={compactButton}>{confirmLabel}</Button>
		</span>
	</form>
{:else}
	<a href={confirmHref} data-nav-title={navigationTitle} onclick={openDialog} aria-haspopup="dialog" class={cn(buttonVariants({ variant: tone }), compactButton)}>{triggerLabel}</a>
	<form method="post" data-nav-title={navigationTitle} hidden bind:this={actionForm}>
		{@render hiddenFields()}
	</form>
	<AlertDialog.Root bind:open={isDialogOpen}>
		<AlertDialog.Content class="gap-3 border border-amber bg-sidebar p-5 font-mono ring-0 sm:max-w-md">
			<AlertDialog.Header>
				<AlertDialog.Title class="text-[15px] font-semibold text-amber">{title}</AlertDialog.Title>
				<AlertDialog.Description class="font-sans text-[14px] text-subheading">{description}</AlertDialog.Description>
			</AlertDialog.Header>
			<AlertDialog.Footer class="-mx-5 -mb-5 items-center border-secondary bg-ground/60 px-5 py-3">
				<span role="status" class="mr-auto flex items-center gap-1.5 text-[13px] text-dim">
					{#if isSubmitting}
						<LoaderCircle class="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
						<span>Working…</span>
					{/if}
				</span>
				<AlertDialog.Cancel class={compactButton} disabled={isSubmitting}>Cancel</AlertDialog.Cancel>
				<AlertDialog.Action variant={confirmVariant} class={compactButton} disabled={isSubmitting} onclick={submitConfirmed}>{confirmLabel}</AlertDialog.Action>
			</AlertDialog.Footer>
		</AlertDialog.Content>
	</AlertDialog.Root>
{/if}
