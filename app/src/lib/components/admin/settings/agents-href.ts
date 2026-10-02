export function agentsHref(cursor?: string): string {
	return cursor ? `/agents?${new URLSearchParams({ cursor })}` : '/agents';
}
