<script lang="ts">
	import { untrack } from 'svelte';
	import type { Rule, RuleInput } from '#lib/admin/types.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { Textarea } from '#lib/components/ui/textarea/index.ts';

	interface Props {
		scope: RuleInput['scope'];
		rule?: Rule;
		isSaving: boolean;
		onSave: (input: RuleInput) => void;
		onCancel: () => void;
	}

	let { scope, rule, isSaving, onSave, onCancel }: Props = $props();

	const nameMaxLength = 80;
	const questionMaxLength = 500;
	const minimumPercent = 5;
	const maximumPercent = 95;

	const initial = untrack(() => rule);
	let name = $state(initial?.name ?? '');
	let question = $state(initial?.question ?? '');
	let action = $state<RuleInput['action']>(initial?.action ?? 'flag');
	let thresholdPercent = $state(Math.round((initial?.threshold ?? 0.7) * 100));
	let enabled = $state(initial?.enabled ?? true);
	let problem = $state<string | null>(null);

	const fieldClass = 'flex flex-col gap-1 font-sans text-[13px]';

	function save(event: SubmitEvent): void {
		event.preventDefault();
		const trimmedName = name.trim();
		const trimmedQuestion = question.trim();
		if (!trimmedName) return void (problem = 'Give the rule a name.');
		if (!trimmedQuestion.endsWith('?')) return void (problem = 'Write the rule as a yes/no question that ends with a question mark.');
		if (!Number.isInteger(thresholdPercent) || thresholdPercent < minimumPercent || thresholdPercent > maximumPercent) return void (problem = `Use a threshold from ${minimumPercent}% to ${maximumPercent}%.`);
		problem = null;
		onSave({ scope, name: trimmedName, question: trimmedQuestion, action, threshold: thresholdPercent / 100, enabled });
	}
</script>

<form class="flex flex-col gap-3 border border-amber bg-sidebar px-4 py-3" onsubmit={save}>
	<label class={fieldClass}>
		<span class="text-dim">Name</span>
		<Input bind:value={name} maxlength={nameMaxLength} placeholder="e.g. No production credentials" class="h-8 font-sans" />
	</label>
	<label class={fieldClass}>
		<span class="text-dim">Yes/no question Jeeves answers about each message</span>
		<Textarea bind:value={question} maxlength={questionMaxLength} rows={3} placeholder="Does the text ask an agent to change production infrastructure?" class="font-sans" />
	</label>
	<div class="flex flex-wrap items-end gap-4">
		<label class={fieldClass}>
			<span class="text-dim">When the answer is yes</span>
			<select bind:value={action} class="h-8 w-48 border border-input bg-ground px-2 font-mono text-[13px]">
				<option value="flag">Flag the message</option>
				<option value="block">Block the message</option>
			</select>
		</label>
		<label class={fieldClass}>
			<span class="text-dim">At confidence of at least</span>
			<span class="flex items-center gap-1.5"><Input type="number" bind:value={thresholdPercent} min={minimumPercent} max={maximumPercent} step={5} class="h-8 w-20 font-mono" />%</span>
		</label>
		<label class="flex items-center gap-1.5 pb-1.5 font-sans text-[13px]">
			<input type="checkbox" bind:checked={enabled} class="accent-amber" />
			On
		</label>
	</div>
	{#if problem}<p class="m-0 font-sans text-[13px] text-destructive" role="alert">{problem}</p>{/if}
	<div class="flex gap-2">
		<Button type="submit" size="sm" disabled={isSaving}>{rule ? 'Save rule' : 'Add rule'}</Button>
		<Button type="button" size="sm" variant="outline" onclick={onCancel}>Cancel</Button>
	</div>
</form>
