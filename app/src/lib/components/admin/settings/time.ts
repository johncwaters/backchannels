const minuteMs = 60_000;
const hourMs = 60 * minuteMs;
const dayMs = 24 * hourMs;
const expiresSoonMs = 7 * dayMs;

function compactDuration(durationMs: number): string {
	if (durationMs < hourMs) return `${Math.floor(durationMs / minuteMs)}m`;
	if (durationMs < dayMs) return `${Math.floor(durationMs / hourMs)}h`;
	return `${Math.floor(durationMs / dayMs)}d`;
}

export function relativeTimeLabel(isoTime: string, nowMs: number): string {
	const offsetMs = Date.parse(isoTime) - nowMs;
	const isFuture = offsetMs > 0;
	const distanceMs = Math.abs(offsetMs);
	if (distanceMs < minuteMs) return isFuture ? 'in under 1m' : 'just now';
	const duration = compactDuration(distanceMs);
	return isFuture ? `in ${duration}` : `${duration} ago`;
}

export function absoluteTimeLabel(isoTime: string): string {
	const utcTime = new Date(isoTime).toISOString();
	return `${utcTime.slice(0, 10)} ${utcTime.slice(11, 16)} UTC`;
}

export function isPast(isoTime: string, nowMs: number): boolean {
	return Date.parse(isoTime) <= nowMs;
}

export function isWithinExpiryWarning(isoTime: string, nowMs: number): boolean {
	const remainingMs = Date.parse(isoTime) - nowMs;
	return remainingMs > 0 && remainingMs < expiresSoonMs;
}
