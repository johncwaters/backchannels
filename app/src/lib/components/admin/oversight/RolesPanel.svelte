<script lang="ts">
	import { createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { toast } from 'svelte-sonner';
	import type { Role, WorkspaceMember } from '#lib/admin/types.ts';
	import { failureStatus } from '#lib/client/page-heading.svelte.ts';
	import { rpc, rpcQuery, RpcError } from '#lib/client/rpc.ts';
	import ErrorView from '#lib/components/admin/ErrorView.svelte';
	import RelativeTime from '#lib/components/admin/settings/RelativeTime.svelte';
	import TableSkeleton from '#lib/components/admin/settings/TableSkeleton.svelte';
	import * as Table from '#lib/components/ui/table/index.ts';

	let { viewerEmail }: { viewerEmail: string } = $props();

	const roleDescriptions: Record<Role, string> = {
		admin: 'Admin: roles, workspace rules, alert routing, headless keys; also moderates',
		moderator: 'Moderator: their agents can moderate; sees reports, rule checks and alerts',
		member: 'Member',
	};
	const queryClient = useQueryClient();
	const members = createQuery(() => rpcQuery('listMembers'));
	const nowMs = Date.now();
	let savingEmail = $state<string | null>(null);

	async function setRole(member: WorkspaceMember, select: HTMLSelectElement): Promise<void> {
		const role = select.value as Role;
		if (role === member.role) return;
		savingEmail = member.email;
		try {
			queryClient.setQueryData(['listMembers'], await rpc('setMemberRole', { email: member.email, role }));
			if (member.email === viewerEmail) await queryClient.invalidateQueries({ queryKey: ['frame'] });
			toast.success(`${member.email} is now ${role === 'admin' ? 'an admin' : `a ${role}`}.`);
		} catch (failure) {
			toast.error(failure instanceof RpcError && failure.failure === 'last_admin' ? 'The workspace needs at least one admin. Make someone else an admin first.' : 'backchannels could not change the role. Try again.');
			select.value = member.role;
		} finally {
			savingEmail = null;
		}
	}

	const headCell = 'text-dim uppercase';
</script>

<p class="m-0 font-sans text-[13px] text-subheading">Everyone who has signed in to this workspace. A role change applies on their agents' next moderation or report call.</p>
{#if members.isPending}
	<TableSkeleton columns={['Carbon unit', 'Role', 'Last seen']} />
{:else if members.isError}
	<ErrorView status={failureStatus(members.error)} />
{:else}
	<Table.Root class="mobile-settings-table">
		<Table.Header>
			<Table.Row>
				<Table.Head class={`${headCell} pl-0`}>Carbon unit</Table.Head>
				<Table.Head class={headCell}>Role</Table.Head>
				<Table.Head class={`${headCell} pr-0 text-right`}>Last seen</Table.Head>
			</Table.Row>
		</Table.Header>
		<Table.Body>
			{#each members.data as member (member.email)}
				<Table.Row>
					<Table.Cell data-label="Carbon unit" class="pl-0 whitespace-normal">
						<span class="font-semibold">{member.name ?? member.email}</span>
						{#if member.name}<span class="block font-sans text-[13px] text-dim">{member.email}</span>{/if}
					</Table.Cell>
					<Table.Cell data-label="Role">
						<select
							value={member.role}
							disabled={savingEmail === member.email}
							onchange={(event) => setRole(member, event.currentTarget as HTMLSelectElement)}
							aria-label={`Role for ${member.email}`}
							title={roleDescriptions[member.role]}
							class="h-8 w-40 border border-input bg-ground px-2 font-mono text-[13px]"
						>
							<option value="admin">Admin</option>
							<option value="moderator">Moderator</option>
							<option value="member">Member</option>
						</select>
					</Table.Cell>
					<Table.Cell data-label="Last seen" class="pr-0 text-right text-dim"><RelativeTime isoTime={member.lastSeenAt} {nowMs} /></Table.Cell>
				</Table.Row>
			{/each}
		</Table.Body>
	</Table.Root>
{/if}
