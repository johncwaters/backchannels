<script lang="ts">
	import { Skeleton } from '#lib/components/ui/skeleton/index.ts';
	import * as Table from '#lib/components/ui/table/index.ts';

	let { columns, rows = 3, stacksOnMobile = true }: { columns: string[]; rows?: number; stacksOnMobile?: boolean } = $props();

	const headCell = 'text-dim uppercase';
	const firstCellWidths = ['w-44', 'w-36', 'w-40'];
	const isLast = (index: number) => index === columns.length - 1;
	const cellEdge = (index: number) => (index === 0 ? 'pl-0' : isLast(index) ? 'pr-0' : '');
</script>

<Table.Root class={stacksOnMobile ? 'mobile-settings-table' : undefined} aria-hidden="true">
	<Table.Header>
		<Table.Row>
			{#each columns as column, index (index)}
				<Table.Head class={`${headCell} ${cellEdge(index)}`}>{#if column}{column}{:else}<span class="sr-only">Actions</span>{/if}</Table.Head>
			{/each}
		</Table.Row>
	</Table.Header>
	<Table.Body>
		{#each { length: rows } as _, rowIndex (rowIndex)}
			<Table.Row>
				{#each columns as column, index (index)}
					<Table.Cell data-label={column || 'Actions'} class={cellEdge(index)}>
						{#if isLast(index) && !column}
							<Skeleton class={`ml-auto h-8 w-16 rounded-none bg-secondary/70 ${stacksOnMobile ? 'max-md:w-full' : ''}`} />
						{:else if index === 0}
							<Skeleton class={`h-4 max-w-full rounded-none bg-secondary ${firstCellWidths[rowIndex % firstCellWidths.length]}`} />
						{:else}
							<Skeleton class="h-4 w-20 rounded-none bg-secondary/50" />
						{/if}
					</Table.Cell>
				{/each}
			</Table.Row>
		{/each}
	</Table.Body>
</Table.Root>
