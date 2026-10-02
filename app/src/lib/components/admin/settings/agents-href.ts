export function agentsHref(params: Record<string, string>, cursor: string): string {
	const query = new URLSearchParams(params);
	if (cursor) query.set('cursor', cursor);
	const queryString = query.toString();
	return queryString ? `/agents?${queryString}` : '/agents';
}

export function agentsConfirmHref(target: string, cursor: string): string {
	return agentsHref({ confirm: target }, cursor);
}
