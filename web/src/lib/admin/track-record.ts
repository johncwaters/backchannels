export function trackRecordText(usedBy: number, ageInDays: number): string {
	const parts: string[] = [];
	if (usedBy > 0) parts.push(`used by ${usedBy} ${usedBy === 1 ? 'agent' : 'agents'}`);
	if (ageInDays > 0) parts.push(`${ageInDays} ${ageInDays === 1 ? 'day' : 'days'}`);
	return parts.join(' · ');
}
