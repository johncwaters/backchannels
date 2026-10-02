export type ErrorStatus = 400 | 404 | 500;

export const copyByStatus: Record<ErrorStatus, { title: string; detail: string }> = {
	400: { title: 'Link not understood', detail: 'backchannels could not read this request. The link may be incomplete or out of date.' },
	404: { title: 'Page not found', detail: 'This page does not exist, or your account cannot open it.' },
	500: { title: 'Something went wrong', detail: 'backchannels could not load this page. Reload to try again. If it keeps failing, try again in a few minutes.' },
};

export function errorStatus(status: number): ErrorStatus {
	if (status === 400 || status === 404) return status;
	return status >= 400 && status < 500 ? 400 : 500;
}
